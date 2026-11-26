//! Packs the install engine and the brand art into Setup.
//!
//! Set by scripts/build-anxhost-setup.js:
//!   ANXHOST_SETUP_ENGINE        the signed NSIS installer to embed (unset for
//!                               the maintenance copy shipped inside the app)
//!   ANXHOST_SETUP_REQUIRE_SIGNATURE  "1" when the engine was verified as
//!                               release-signed (Setup then refuses anything else)
//!   ANXHOST_SETUP_APP_BYTES     size of the installed app, for real progress
//!   ANXHOST_SETUP_ARTIFACT_VERSION  "2.0-build216"
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

fn base64(bytes: &[u8]) -> String {
  const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::new();
  for c in bytes.chunks(3) {
    let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
    let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
    out.push(T[(n >> 18) as usize & 63] as char);
    out.push(T[(n >> 12) as usize & 63] as char);
    out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
  }
  out
}

fn env(name: &str) -> Option<String> {
  println!("cargo:rerun-if-env-changed={name}");
  std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn main() {
  let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
  let repo = Path::new("../..");

  // The engine is appended to the built Setup (scripts/build-anxhost-setup.js,
  // like NSIS's own data); only its SHA-256 and size are compiled in, so the
  // copy Setup finds at run time must be exactly the one built against.
  let mut sha = String::new();
  let mut size = 0u64;
  if let Some(path) = env("ANXHOST_SETUP_ENGINE") {
    println!("cargo:rerun-if-changed={path}");
    let mut file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("ANXHOST_SETUP_ENGINE={path}: {e}"));
    let mut head = [0u8; 2];
    std::io::Read::read_exact(&mut file, &mut head).unwrap();
    assert_eq!(&head, b"MZ", "ANXHOST_SETUP_ENGINE is not a Windows program");
    let mut file = std::fs::File::open(&path).unwrap();
    let mut hasher = Sha256::new();
    size = std::io::copy(&mut file, &mut hasher).unwrap();
    sha = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
  }
  println!("cargo:rustc-env=ANXHOST_ENGINE_SHA256={sha}");
  println!("cargo:rustc-env=ANXHOST_ENGINE_SIZE={size}");
  let require = env("ANXHOST_SETUP_REQUIRE_SIGNATURE").map(|v| v == "1").unwrap_or(false);
  println!("cargo:rustc-env=ANXHOST_REQUIRE_SIGNATURE={}", if require { "1" } else { "0" });
  let app_bytes: u64 = env("ANXHOST_SETUP_APP_BYTES").and_then(|v| v.parse().ok()).unwrap_or(0);
  println!("cargo:rustc-env=ANXHOST_APP_BYTES={app_bytes}");

  // The build being installed.
  let artifact = env("ANXHOST_SETUP_ARTIFACT_VERSION").unwrap_or_else(|| {
    let release: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(repo.join("release.json")).unwrap()).unwrap();
    format!("{}-build{}", release["version"].as_str().unwrap_or("2.0"), release["build"])
  });
  println!("cargo:rerun-if-changed=../../release.json");
  let build = artifact.rsplit("-build").next().unwrap_or("").to_string();
  println!("cargo:rustc-env=ANXHOST_ARTIFACT_VERSION={artifact}");
  println!("cargo:rustc-env=ANXHOST_BUILD={build}");

  // Approved brand art (docs/anxhost/brand), as data for ui.html.
  for (file, name) in [
    ("anxhost-mark-option-a-dark.svg", "mark.b64"),
    ("anxhost-wordmark-tagline-dark.svg", "word.b64"),
    ("anxhost-icon-small.svg", "icon.b64"),
  ] {
    let source = repo.join("docs/anxhost/brand/svg").join(file);
    println!("cargo:rerun-if-changed={}", source.display());
    std::fs::write(out.join(name), base64(&std::fs::read(&source).unwrap())).unwrap();
  }

  // Icon, version information and manifest.
  println!("cargo:rerun-if-changed=../../assets/icon.ico");
  println!("cargo:rerun-if-changed=setup.manifest");
  let mut res = tauri_winres::WindowsResource::new();
  res.set_icon("../../assets/icon.ico");
  res.set("ProductName", "AnxHost Setup");
  res.set("FileDescription", "AnxHost Control Center Setup");
  res.set("CompanyName", "AnxLabs");
  res.set("LegalCopyright", "AnxLabs");
  res.set("OriginalFilename", "AnxHost Setup.exe");
  res.set("ProductVersion", &artifact);
  res.set("FileVersion", &format!("2.0.0.{build}"));
  res.set_manifest_file("setup.manifest");
  res.compile().expect("Setup resources");
}
