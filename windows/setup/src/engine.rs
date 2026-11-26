//! The install engine: electron-builder's signed NSIS installer, embedded at
//! build time and run silently. Setup never installs files itself; it decides
//! the options, shows progress and reports the result.
//!
//! Before the engine runs it is written to a private temp folder, held open so
//! nothing can change it, and must match the SHA-256 recorded at build time.
//! Release builds also require a valid Authenticode signature from the
//! AnxHost publisher (the same identity the app's updater pins).
//!
//! Progress is measured, never timed: the engine reports its phases in a
//! status file (/ANXSTATUS=, written by windows/installer.nsh) and the bar is
//! the bytes really written (first into the engine's extraction folder, then
//! into the install folder) against the app size recorded at build time.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::detect;

pub const ENGINE_SHA256: &str = env!("ANXHOST_ENGINE_SHA256");
pub const ENGINE_SIZE: u64 = parse_u64(env!("ANXHOST_ENGINE_SIZE"));
/// Marks the engine appended after Setup's own program (see payload_range).
pub const PAYLOAD_MAGIC: &[u8; 16] = b"ANXHOST-ENGINE-1";
pub const REQUIRE_SIGNATURE: bool = matches!(env!("ANXHOST_REQUIRE_SIGNATURE").as_bytes(), b"1");
/// Bytes of the installed app (dist/win-unpacked), for the progress bar.
pub const APP_BYTES: u64 = parse_u64(env!("ANXHOST_APP_BYTES"));
/// The publisher on release installers (src/shared/installerSignature.js).
pub const PUBLISHER_CN: &str = "Anjo ROSIMO";
pub const ISSUER_CN_PREFIX: &str = "Microsoft ID Verified CS";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;

const fn parse_u64(text: &str) -> u64 {
  let bytes = text.as_bytes();
  let mut value = 0u64;
  let mut i = 0;
  while i < bytes.len() {
    let digit = bytes[i];
    if digit < b'0' || digit > b'9' {
      return 0;
    }
    value = value * 10 + (digit - b'0') as u64;
    i += 1;
  }
  value
}

/// This build was made around an engine (the uninstall copy inside the app
/// is not).
pub fn has_engine() -> bool {
  !ENGINE_SHA256.is_empty() && ENGINE_SIZE > 0
}

fn read_u32(buf: &[u8], at: usize) -> Option<u32> {
  buf.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Where the appended engine lies in `file`: Setup's program, then the
/// engine, then its length (u64) and PAYLOAD_MAGIC, then (once signed) the
/// Authenticode certificate table, which signing may precede with up to 7
/// zero bytes. The certificate table's offset comes from the PE header's
/// security directory; without a signature the footer ends the file.
pub fn payload_range(file: &mut File) -> std::io::Result<Option<(u64, u64)>> {
  let len = file.metadata()?.len();
  let mut header = vec![0u8; 4096.min(len as usize)];
  file.seek(SeekFrom::Start(0))?;
  file.read_exact(&mut header)?;
  let mut end = len;
  if header.starts_with(b"MZ") {
    if let Some(pe) = read_u32(&header, 0x3C).map(|v| v as usize) {
      if header.get(pe..pe + 4) == Some(b"PE\0\0") {
        let optional = pe + 24;
        let magic = header.get(optional..optional + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
        // Data directories start at 96 (PE32) or 112 (PE32+); security is #4.
        let dirs = match magic {
          Some(0x20b) => optional + 112,
          Some(0x10b) => optional + 96,
          _ => 0,
        };
        if dirs > 0 {
          if let (Some(cert_at), Some(cert_size)) = (read_u32(&header, dirs + 32), read_u32(&header, dirs + 36)) {
            if cert_at > 0 && cert_size > 0 && (cert_at as u64) <= len {
              end = cert_at as u64;
            }
          }
        }
      }
    }
  }
  let footer = 8 + PAYLOAD_MAGIC.len() as u64;
  for pad in 0..8u64 {
    if end < footer + pad {
      break;
    }
    let at = end - pad - footer;
    let mut buf = vec![0u8; (footer + pad) as usize];
    file.seek(SeekFrom::Start(at))?;
    file.read_exact(&mut buf)?;
    if buf[footer as usize..].iter().any(|&b| b != 0) {
      continue;
    }
    if &buf[8..footer as usize] == PAYLOAD_MAGIC {
      let size = u64::from_le_bytes(buf[..8].try_into().unwrap());
      if size > 0 && size <= at {
        return Ok(Some((at - size, size)));
      }
    }
  }
  Ok(None)
}

/// The packaging script's format (scripts/build-anxhost-setup.js
/// appendPayload), for tests: appends `engine`.
#[cfg(test)]
pub fn append_payload(setup: &mut File, engine: &[u8]) -> std::io::Result<()> {
  use std::io::Write;
  setup.seek(SeekFrom::End(0))?;
  let len = setup.stream_position()?;
  let footer = 8 + PAYLOAD_MAGIC.len() as u64;
  // Pad so the footer ends on 8 bytes: signing then adds no padding.
  let pad = (8 - (len + engine.len() as u64 + footer) % 8) % 8;
  setup.write_all(&vec![0u8; pad as usize])?;
  setup.write_all(engine)?;
  setup.write_all(&(engine.len() as u64).to_le_bytes())?;
  setup.write_all(PAYLOAD_MAGIC)?;
  Ok(())
}

/// What the person (or the command line) chose.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Options {
  pub silent: bool,
  pub uninstall: bool,
  pub dir: Option<PathBuf>,
  pub no_helper: bool,
  pub all_users: bool,
  pub current_user: bool,
  pub updated: bool,
  pub force_run: bool,
}

impl Options {
  pub fn from_args(args: &[String]) -> Options {
    let mut o = Options::default();
    for arg in args {
      let lower = arg.to_ascii_lowercase();
      match lower.as_str() {
        "/s" | "--silent" => o.silent = true,
        "--uninstall" => o.uninstall = true,
        "/nohelper" => o.no_helper = true,
        "/allusers" => o.all_users = true,
        "/currentuser" => o.current_user = true,
        "--updated" => o.updated = true,
        "--force-run" => o.force_run = true,
        _ if lower.starts_with("/d=") => o.dir = Some(PathBuf::from(&arg[3..])),
        _ => {}
      }
    }
    o
  }

  /// The engine's command line. NSIS requires /D= last and unquoted.
  pub fn engine_args(&self, status: Option<&Path>) -> Vec<String> {
    let mut args = vec!["/S".to_string()];
    if self.all_users {
      args.push("/allusers".into());
    } else if self.current_user {
      args.push("/currentuser".into());
    }
    if self.no_helper {
      args.push("/NOHELPER".into());
    }
    if self.updated {
      args.push("--updated".into());
    }
    if self.force_run {
      args.push("--force-run".into());
    }
    if let Some(status) = status {
      args.push(format!("/ANXSTATUS={}", status.display()));
    }
    if let Some(dir) = &self.dir {
      args.push(format!("/D={}", dir.display()));
    }
    args
  }
}

/// The engine, written out, verified and held open until it has run.
pub struct Prepared {
  pub dir: PathBuf,
  pub exe: PathBuf,
  _lock: File,
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_of(file: &mut File) -> std::io::Result<String> {
  file.seek(SeekFrom::Start(0))?;
  let mut hasher = Sha256::new();
  let mut buf = vec![0u8; 1 << 20];
  loop {
    let n = file.read(&mut buf)?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  Ok(hex(&hasher.finalize()))
}

/// Writes the engine to %TEMP%\AnxHostSetup-<pid>\ and proves it is the one
/// built into this Setup before anything runs it.
pub fn prepare(log: &mut dyn FnMut(String)) -> Result<Prepared, String> {
  if !has_engine() {
    return Err("This Setup was built without its installer inside (a development build), so it cannot install.".into());
  }
  let dir = std::env::temp_dir().join(format!("AnxHostSetup-{}", std::process::id()));
  std::fs::create_dir_all(&dir).map_err(|e| format!("Setup could not use its temporary folder ({e})."))?;
  let exe = dir.join("AnxHost Engine.exe");
  let me = std::env::current_exe().map_err(|e| format!("Setup could not find itself ({e})."))?;
  let mut source = File::open(&me).map_err(|e| format!("Setup could not read itself ({e})."))?;
  let (offset, size) = payload_range(&mut source)
    .map_err(|e| format!("Setup could not read itself ({e})."))?
    .ok_or("The installer inside this Setup is missing (the file is incomplete). Download Setup again.")?;
  if size != ENGINE_SIZE {
    return Err("The installer inside this Setup is damaged (its size does not match). Download Setup again.".into());
  }
  {
    let mut target = File::create(&exe).map_err(|e| format!("Setup could not unpack its installer ({e}). Check that the drive has free space."))?;
    source.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    std::io::copy(&mut (&mut source).take(size), &mut target).map_err(|e| format!("Setup could not unpack its installer ({e}). Check that the drive has free space."))?;
  }
  // Read access only, and only reads shared: no other program can change or
  // replace the file between the checks below and the moment it runs.
  let mut lock = OpenOptions::new()
    .read(true)
    .share_mode(FILE_SHARE_READ)
    .open(&exe)
    .map_err(|e| format!("Setup could not open its installer ({e})."))?;
  let actual = sha256_of(&mut lock).map_err(|e| format!("Setup could not read its installer ({e})."))?;
  if !ENGINE_SHA256.eq_ignore_ascii_case(&actual) {
    return Err("The installer inside this Setup is damaged (its checksum does not match). Download Setup again.".into());
  }
  log(format!("engine SHA-256 matches the build ({}…)", &actual[..16]));
  match crate::trust::verify(&exe) {
    Ok(signer) => {
      if REQUIRE_SIGNATURE && !(signer.subject_cn == PUBLISHER_CN && signer.issuer_cn.starts_with(ISSUER_CN_PREFIX)) {
        return Err(format!("The installer inside this Setup is signed by \"{}\", not by AnxLabs' publisher, so it was not run.", signer.subject_cn));
      }
      log(format!("engine Authenticode valid: {} (issuer {})", signer.subject_cn, signer.issuer_cn));
    }
    Err(reason) if REQUIRE_SIGNATURE => {
      return Err(format!("Windows could not verify the installer's signature ({reason}), so it was not run. Download Setup again."));
    }
    Err(reason) => log(format!("engine not signed (development build): {reason}")),
  }
  Ok(Prepared { dir, exe, _lock: lock })
}

/// One line the engine writes to the status file.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
  Start,
  PluginsDir(PathBuf),
  Extracted,
  Registered,
  HelperBegin,
  Helper(String),
  HelperSkipped,
  Done,
  Other(String),
}

pub fn parse_status(line: &str) -> Option<Status> {
  let line = line.trim();
  let (word, rest) = line.split_once(' ').map(|(w, r)| (w, r.trim())).unwrap_or((line, ""));
  Some(match word {
    "" => return None,
    "start" => Status::Start,
    "plugins" if !rest.is_empty() => Status::PluginsDir(PathBuf::from(rest)),
    "extracted" => Status::Extracted,
    "registered" => Status::Registered,
    "helper-begin" => Status::HelperBegin,
    "helper" => Status::Helper(rest.to_string()),
    "helper-skipped" => Status::HelperSkipped,
    "done" => Status::Done,
    _ => Status::Other(line.to_string()),
  })
}

/// Bytes under a folder (0 if it does not exist yet).
pub fn folder_bytes(dir: &Path) -> u64 {
  let mut total = 0;
  let mut stack = vec![dir.to_path_buf()];
  while let Some(d) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&d) else { continue };
    for entry in entries.flatten() {
      let Ok(meta) = entry.metadata() else { continue };
      if meta.is_dir() {
        stack.push(entry.path());
      } else {
        total += meta.len();
      }
    }
  }
  total
}

/// The copy phase's share of the bar: extraction is most of the work.
const EXTRACT_SHARE: f64 = 0.8;

/// The measured fraction of "copying program files" (0..1), or None when the
/// app size is unknown (then the step shows without a percentage).
pub fn copy_fraction(extracted: u64, in_place: u64, total: u64) -> Option<f64> {
  if total == 0 {
    return None;
  }
  let e = (extracted as f64 / total as f64).min(1.0);
  let c = (in_place as f64 / total as f64).min(1.0);
  Some((EXTRACT_SHARE * e + (1.0 - EXTRACT_SHARE) * c).clamp(0.0, 1.0))
}

/// What the window shows while the engine runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
  Step(&'static str),
  Copy { fraction: Option<f64>, bytes: u64 },
  Log(String),
}

pub struct Outcome {
  pub exit_code: i32,
  pub helper: Option<String>,
  pub reached: &'static str,
}

/// Runs the engine and reports measured progress until it exits.
pub fn run(engine: &Path, options: &Options, install_dir: &Path, status: &Path, on: &mut dyn FnMut(Event)) -> Result<Outcome, String> {
  let _ = std::fs::remove_file(status);
  let args = options.engine_args(Some(status));
  on(Event::Log(format!("engine {}", args.join(" "))));
  let child = Command::new(engine)
    .args(&args)
    .creation_flags(CREATE_NO_WINDOW)
    .spawn()
    .map_err(|e| format!("Windows did not start the installer ({e})."))?;
  drive(child, install_dir, status, on)
}

/// Separate from run() so tests can drive a stand-in engine.
pub fn drive(mut child: Child, install_dir: &Path, status: &Path, on: &mut dyn FnMut(Event)) -> Result<Outcome, String> {
  let mut read = 0usize;
  let mut plugins: Option<PathBuf> = None;
  let mut reached: &'static str = "close";
  let mut helper = None;
  let mut last_measure = Instant::now() - Duration::from_secs(1);
  on(Event::Step("close"));
  loop {
    let exited = child.try_wait().map_err(|e| format!("Setup lost track of the installer ({e})."))?;
    if let Ok(text) = std::fs::read_to_string(status) {
      if text.len() > read {
        // Only whole lines; a partial last line is read next time.
        let fresh = &text[read..];
        let upto = fresh.rfind('\n').map(|i| i + 1).unwrap_or(0);
        for line in fresh[..upto].lines() {
          on(Event::Log(format!("engine: {}", line.trim())));
          match parse_status(line) {
            Some(Status::PluginsDir(dir)) => plugins = Some(dir),
            Some(Status::Extracted) | Some(Status::Registered) => {
              if reached == "close" || reached == "copy" {
                on(Event::Copy { fraction: if APP_BYTES > 0 { Some(1.0) } else { None }, bytes: APP_BYTES });
                reached = "register";
                on(Event::Step("register"));
              }
            }
            Some(Status::HelperBegin) => {
              reached = "helper";
              on(Event::Step("helper"));
            }
            Some(Status::Helper(code)) => helper = Some(code),
            Some(Status::HelperSkipped) => helper = Some("skipped".into()),
            _ => {}
          }
        }
        read += upto;
      }
    }
    if reached == "close" || reached == "copy" {
      if last_measure.elapsed() >= Duration::from_millis(400) {
        last_measure = Instant::now();
        let extracted = plugins.as_ref().map(|p| folder_bytes(&p.join("7z-out"))).unwrap_or(0);
        if extracted > 0 && reached == "close" {
          reached = "copy";
          on(Event::Step("copy"));
        }
        if reached == "copy" {
          let in_place = folder_bytes(install_dir);
          on(Event::Copy { fraction: copy_fraction(extracted, in_place, APP_BYTES), bytes: extracted });
        }
      }
    }
    if let Some(code) = exited {
      let exit_code = code.code().unwrap_or(1);
      on(Event::Log(format!("engine exited with code {exit_code}")));
      return Ok(Outcome { exit_code, helper, reached });
    }
    std::thread::sleep(Duration::from_millis(120));
  }
}

/// `Setup.exe /S`: the engine with no window, its exit code passed on.
pub fn silent(options: &Options) -> i32 {
  if options.uninstall {
    return crate::uninstall::silent();
  }
  let mut log = |_: String| {};
  match prepare(&mut log) {
    Ok(prepared) => {
      let code = Command::new(&prepared.exe)
        .args(options.engine_args(None))
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.code().unwrap_or(1))
        .unwrap_or(1);
      drop(prepared._lock);
      let _ = std::fs::remove_dir_all(&prepared.dir);
      code
    }
    Err(_) => 1,
  }
}

/// The folder the engine will install to.
pub fn target_dir(options: &Options, installed: Option<&detect::Installed>) -> PathBuf {
  options
    .dir
    .clone()
    .or_else(|| installed.and_then(|i| i.location.clone()))
    .unwrap_or_else(detect::default_location)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn options_round_trip() {
    let o = Options::from_args(&["/S".into(), "/NOHELPER".into(), "/D=D:\\Apps\\AnxOS Control Center".into()]);
    assert!(o.silent && o.no_helper);
    let args = o.engine_args(Some(Path::new("C:\\t\\s.txt")));
    assert_eq!(args.first().unwrap(), "/S");
    assert_eq!(args.last().unwrap(), "/D=D:\\Apps\\AnxOS Control Center", "/D= is last");
    assert!(args.contains(&"/ANXSTATUS=C:\\t\\s.txt".to_string()));
  }

  /// An engine appended to a real Windows program is found again, also
  /// behind the zero padding signing may add; a plain program has none.
  #[test]
  fn appended_engine_is_found() {
    let dir = std::env::temp_dir().join(format!("anxhost-payload-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let setup = dir.join("setup.exe");
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    std::fs::copy(Path::new(&system).join("System32").join("whoami.exe"), &setup).unwrap();
    let mut plain = File::open(&setup).unwrap();
    assert_eq!(payload_range(&mut plain).unwrap(), None, "no engine in a plain program");
    drop(plain);
    let engine: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
    let mut f = OpenOptions::new().read(true).write(true).open(&setup).unwrap();
    append_payload(&mut f, &engine).unwrap();
    let (at, size) = payload_range(&mut f).unwrap().expect("found");
    assert_eq!(size, engine.len() as u64);
    let mut back = vec![0u8; size as usize];
    f.seek(SeekFrom::Start(at)).unwrap();
    f.read_exact(&mut back).unwrap();
    assert_eq!(back, engine);
    assert_eq!(f.metadata().unwrap().len() % 8, 0, "footer ends on 8 bytes");
    // Zero padding after the footer is tolerated.
    use std::io::Write;
    f.seek(SeekFrom::End(0)).unwrap();
    f.write_all(&[0u8; 5]).unwrap();
    assert_eq!(payload_range(&mut f).unwrap(), Some((at, size)));
    // As after signing: a certificate table follows, named by the PE header.
    let cert_at = f.metadata().unwrap().len();
    f.write_all(&[0xA5u8; 64]).unwrap();
    let mut head = vec![0u8; 1024];
    f.seek(SeekFrom::Start(0)).unwrap();
    f.read_exact(&mut head).unwrap();
    let pe = read_u32(&head, 0x3C).unwrap() as usize;
    let dirs = pe + 24 + if u16::from_le_bytes([head[pe + 24], head[pe + 25]]) == 0x20b { 112 } else { 96 };
    f.seek(SeekFrom::Start((dirs + 32) as u64)).unwrap();
    f.write_all(&(cert_at as u32).to_le_bytes()).unwrap();
    f.write_all(&64u32.to_le_bytes()).unwrap();
    assert_eq!(payload_range(&mut f).unwrap(), Some((at, size)), "found before the certificate table");
    drop(f);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// The engine is held open (read access, only reads shared) while it runs:
  /// Windows can still start it, and nothing can rewrite or replace it.
  #[test]
  fn held_engine_still_runs_and_cannot_change() {
    let dir = std::env::temp_dir().join(format!("anxhost-lock-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("engine.exe");
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    std::fs::copy(Path::new(&system).join("System32").join("whoami.exe"), &exe).unwrap();
    let mut lock = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&exe).unwrap();
    assert!(!sha256_of(&mut lock).unwrap().is_empty());
    assert!(OpenOptions::new().write(true).open(&exe).is_err(), "no writer while held");
    assert!(std::fs::remove_file(&exe).is_err(), "no delete while held");
    let status = Command::new(&exe).creation_flags(CREATE_NO_WINDOW).output().unwrap().status;
    assert!(status.success(), "the held program still starts");
    drop(lock);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn status_lines() {
    assert_eq!(parse_status("plugins C:\\Temp\\nsa1.tmp"), Some(Status::PluginsDir("C:\\Temp\\nsa1.tmp".into())));
    assert_eq!(parse_status("helper 1223"), Some(Status::Helper("1223".into())));
    assert_eq!(parse_status("  "), None);
    assert_eq!(parse_status("extracted"), Some(Status::Extracted));
  }

  #[test]
  fn progress_is_measured() {
    assert_eq!(copy_fraction(0, 0, 0), None, "unknown size: no percentage is invented");
    assert_eq!(copy_fraction(50, 0, 100), Some(0.4));
    assert_eq!(copy_fraction(100, 100, 100), Some(1.0));
    assert_eq!(copy_fraction(500, 500, 100), Some(1.0));
  }

  /// A stand-in engine (PowerShell) writes phases and files; drive() reports
  /// them in order and returns its exit code.
  #[test]
  fn drives_a_stand_in_engine() {
    let dir = std::env::temp_dir().join(format!("anxhost-setup-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("plugins").join("7z-out")).unwrap();
    let status = dir.join("status.txt");
    let script = format!(
      "Add-Content '{s}' 'start'; Add-Content '{s}' 'plugins {p}'; Set-Content '{p}\\7z-out\\a.bin' ('x'*4096); Start-Sleep -Milliseconds 600; \
       Add-Content '{s}' 'extracted'; Add-Content '{s}' 'registered'; Add-Content '{s}' 'helper-begin'; Add-Content '{s}' 'helper 0'; Add-Content '{s}' 'done'; exit 3",
      s = status.display(),
      p = dir.join("plugins").display()
    );
    let child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).spawn().unwrap();
    let mut steps = vec![];
    let outcome = drive(child, &dir.join("install"), &status, &mut |e| {
      if let Event::Step(s) = e {
        steps.push(s)
      }
    })
    .unwrap();
    assert_eq!(outcome.exit_code, 3);
    assert_eq!(outcome.helper.as_deref(), Some("0"));
    assert_eq!(steps.first(), Some(&"close"));
    assert!(steps.contains(&"register") && steps.contains(&"helper"), "{steps:?}");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
