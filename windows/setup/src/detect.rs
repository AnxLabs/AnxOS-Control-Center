//! What is installed on this PC, read from the registry electron-builder's
//! NSIS installer writes (the install engine; never written here).
//!
//! Keys are named after the app's GUID, which electron-builder derives from the
//! frozen appId `com.anxos.controlcenter` (UUID v5; checked by
//! scripts/anxhost-setup-contract-smoke.js):
//!   Software\<GUID>                                  InstallLocation, AnxHostBuild
//!   Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>   DisplayName, UninstallString
//! Builds up to 215 registered as "AnxOS Control Center" and record no build;
//! 216 and later register as "AnxHost Control Center" and record AnxHostBuild.

use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY};

pub const APP_GUID: &str = "3f8b9dfa-3a76-52ec-8ba9-f2ea082d6457";
/// The install folder and executable names are frozen identifiers.
pub const APP_FOLDER_NAME: &str = "AnxOS Control Center";
pub const APP_EXE: &str = "AnxOS Control Center.exe";
pub const UNINSTALLER_EXE: &str = "Uninstall AnxOS Control Center.exe";

/// The build this Setup installs ("216"), from the release version.
pub const BUILD: &str = env!("ANXHOST_BUILD");
pub const ARTIFACT_VERSION: &str = env!("ANXHOST_ARTIFACT_VERSION");

#[derive(Clone, Debug, Default)]
pub struct Installed {
  pub location: Option<PathBuf>,
  pub display_name: String,
  pub build: Option<String>,
  pub uninstall_string: String,
  pub all_users: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
  Fresh,
  /// AnxOS Control Center (Build 215 or earlier) is installed.
  AnxOs,
  /// An older AnxHost build (or one whose build is unknown).
  Update { from: Option<String> },
  /// The same build is installed.
  Repair,
  /// A newer build is installed; installing would go back.
  Newer { installed: String },
}

impl Mode {
  pub fn key(&self) -> &'static str {
    match self {
      Mode::Fresh => "fresh",
      Mode::AnxOs => "anxos",
      Mode::Update { .. } => "update",
      Mode::Repair => "repair",
      Mode::Newer { .. } => "newer",
    }
  }
}

fn read_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
  let subkey = HSTRING::from(subkey);
  let value = HSTRING::from(value);
  let flags = if root == HKEY_LOCAL_MACHINE { RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY } else { RRF_RT_REG_SZ };
  let mut size: u32 = 0;
  unsafe {
    if RegGetValueW(root, PCWSTR(subkey.as_ptr()), PCWSTR(value.as_ptr()), flags, None, None, Some(&mut size)).is_err() || size == 0 {
      return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut bytes = (buf.len() * 2) as u32;
    if RegGetValueW(root, PCWSTR(subkey.as_ptr()), PCWSTR(value.as_ptr()), flags, None, Some(buf.as_mut_ptr().cast()), Some(&mut bytes)).is_err() {
      return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let text = String::from_utf16_lossy(&buf[..len]).trim().to_string();
    (!text.is_empty()).then_some(text)
  }
}

fn read_root(root: HKEY, all_users: bool) -> Option<Installed> {
  let install_key = format!("Software\\{APP_GUID}");
  let uninstall_key = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{APP_GUID}");
  let location = read_string(root, &install_key, "InstallLocation").map(PathBuf::from);
  let display_name = read_string(root, &uninstall_key, "DisplayName").unwrap_or_default();
  if location.is_none() && display_name.is_empty() {
    return None;
  }
  Some(Installed {
    location,
    display_name,
    build: read_string(root, &install_key, "AnxHostBuild"),
    uninstall_string: read_string(root, &uninstall_key, "UninstallString").unwrap_or_default(),
    all_users,
  })
}

/// The installation on this PC, per user first (the default), then for all users.
pub fn installed() -> Option<Installed> {
  read_root(HKEY_CURRENT_USER, false).or_else(|| read_root(HKEY_LOCAL_MACHINE, true))
}

/// Pure, so it is unit-tested: which kind of Setup this is.
pub fn mode_for(installed: Option<&Installed>, this_build: &str) -> Mode {
  let Some(found) = installed else { return Mode::Fresh };
  if found.display_name.starts_with("AnxOS") {
    return Mode::AnxOs;
  }
  match found.build.as_deref() {
    Some(b) if b == this_build => Mode::Repair,
    Some(b) if build_number(b) > build_number(this_build) && build_number(this_build) > 0 => Mode::Newer { installed: b.to_string() },
    other => Mode::Update { from: other.map(str::to_string) },
  }
}

fn build_number(build: &str) -> u32 {
  build.trim().parse().unwrap_or(0)
}

/// electron-builder's per-user default: %LOCALAPPDATA%\Programs\AnxOS Control Center.
pub fn default_location() -> PathBuf {
  let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
  base.join("Programs").join(APP_FOLDER_NAME)
}

/// The engine's own rule for a chosen folder (its install-folder page adds
/// the app folder when the path does not name it), so a custom choice lands
/// where the old wizard would have put it.
pub fn normalize_location(chosen: &Path) -> PathBuf {
  let text = chosen.to_string_lossy();
  if text.to_ascii_lowercase().contains(&APP_FOLDER_NAME.to_ascii_lowercase()) {
    chosen.to_path_buf()
  } else {
    chosen.join(APP_FOLDER_NAME)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn found(name: &str, build: Option<&str>) -> Installed {
    Installed { display_name: name.into(), build: build.map(str::to_string), location: Some("C:\\x".into()), ..Default::default() }
  }

  #[test]
  fn modes() {
    assert_eq!(mode_for(None, "216"), Mode::Fresh);
    assert_eq!(mode_for(Some(&found("AnxOS Control Center", None)), "216"), Mode::AnxOs);
    assert_eq!(mode_for(Some(&found("AnxHost Control Center", Some("216"))), "216"), Mode::Repair);
    assert_eq!(mode_for(Some(&found("AnxHost Control Center", Some("216"))), "217"), Mode::Update { from: Some("216".into()) });
    assert_eq!(mode_for(Some(&found("AnxHost Control Center", None)), "217"), Mode::Update { from: None });
    assert_eq!(mode_for(Some(&found("AnxHost Control Center", Some("218"))), "217"), Mode::Newer { installed: "218".into() });
  }

  #[test]
  fn folder_rule() {
    assert_eq!(normalize_location(Path::new("D:\\Apps")), PathBuf::from("D:\\Apps\\AnxOS Control Center"));
    assert_eq!(normalize_location(Path::new("D:\\Apps\\AnxOS Control Center")), PathBuf::from("D:\\Apps\\AnxOS Control Center"));
  }
}
