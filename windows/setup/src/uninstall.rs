//! Uninstall: the engine's own uninstaller does the work, silently, with the
//! install mode its registry entry carries (/currentuser or /allusers). It
//! keeps the user's data (electron-builder never deletes app data here), and
//! its customUnInstall removes the Helper's startup task (Windows may ask for
//! approval). Settings > Apps still lists the NSIS uninstaller; it hands an
//! interactive uninstall to this window (windows/installer.nsh customUnInit).

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::detect::{self, Installed};
use crate::engine::folder_bytes;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Started from inside the install folder (the copy in resources\): run a
/// copy from the temp folder instead, so the uninstaller can remove the
/// folder. Returns Some(exit code) when this process should end.
pub fn relaunch_from_temp(args: &[String]) -> Option<i32> {
  let me = std::env::current_exe().ok()?;
  let installed = detect::installed()?;
  let location = installed.location?;
  let inside = me.to_string_lossy().to_ascii_lowercase().starts_with(&location.to_string_lossy().to_ascii_lowercase());
  if !inside || args.iter().any(|a| a == "--relaunched") {
    return None;
  }
  let dir = std::env::temp_dir().join(format!("AnxHostSetup-{}", std::process::id()));
  std::fs::create_dir_all(&dir).ok()?;
  let copy = dir.join("AnxHost Setup.exe");
  std::fs::copy(&me, &copy).ok()?;
  let mut forwarded = args.to_vec();
  forwarded.push("--relaunched".into());
  Command::new(&copy).args(&forwarded).spawn().ok()?;
  Some(0)
}

fn uninstaller_args(installed: &Installed) -> Vec<String> {
  let mut args = vec!["/S".to_string()];
  let mode = installed.uninstall_string.to_ascii_lowercase();
  if mode.contains("/allusers") {
    args.push("/allusers".into());
  } else if mode.contains("/currentuser") {
    args.push("/currentuser".into());
  }
  args
}

/// Runs the uninstaller in place (_?= makes it wait and not copy itself) and
/// reports the share of program files removed. Returns its exit code.
pub fn run(installed: &Installed, on: &mut dyn FnMut(f64, String)) -> Result<i32, String> {
  let location = installed.location.clone().ok_or("The install folder is not recorded, so Setup cannot find the uninstaller.")?;
  let uninstaller = location.join(detect::UNINSTALLER_EXE);
  if !uninstaller.exists() {
    return Err(format!("The uninstaller is missing from {}. Run Setup again and choose Repair first.", location.display()));
  }
  let before = folder_bytes(&location).max(1);
  let mut args = uninstaller_args(installed);
  args.push(format!("_?={}", location.display()));
  on(0.0, format!("uninstaller {}", args.join(" ")));
  let mut child = Command::new(&uninstaller)
    .args(&args)
    .creation_flags(CREATE_NO_WINDOW)
    .spawn()
    .map_err(|e| format!("Windows did not start the uninstaller ({e})."))?;
  let code = loop {
    if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
      break status.code().unwrap_or(1);
    }
    let now = folder_bytes(&location);
    on((1.0 - now as f64 / before as f64).clamp(0.0, 1.0), String::new());
    std::thread::sleep(Duration::from_millis(300));
  };
  on(1.0, format!("uninstaller exited with code {code}"));
  if code == 0 {
    cleanup(&location);
  }
  Ok(code)
}

/// What _?= leaves behind: the uninstaller itself and an empty folder.
fn cleanup(location: &Path) {
  let _ = std::fs::remove_file(location.join(detect::UNINSTALLER_EXE));
  let _ = std::fs::remove_dir(location.join("resources"));
  let _ = std::fs::remove_dir(location);
}

/// `Setup.exe --uninstall /S`.
pub fn silent() -> i32 {
  match detect::installed() {
    Some(installed) => run(&installed, &mut |_, _| {}).unwrap_or(1),
    None => 0,
  }
}

pub fn data_folder() -> PathBuf {
  std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("AnxHub")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keeps_the_install_mode() {
    let mut i = Installed { uninstall_string: "\"C:\\x\\Uninstall AnxOS Control Center.exe\" /currentuser".into(), ..Default::default() };
    assert_eq!(uninstaller_args(&i), vec!["/S", "/currentuser"]);
    i.uninstall_string = "\"C:\\x\\Uninstall AnxOS Control Center.exe\" /allusers".into();
    assert_eq!(uninstaller_args(&i), vec!["/S", "/allusers"]);
  }
}
