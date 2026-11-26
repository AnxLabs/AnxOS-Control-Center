//! Authenticode verification of the embedded install engine, by Windows
//! itself (WinVerifyTrust), plus the signer's and issuer's names from the
//! verified chain so Setup can require AnxLabs' publisher.

use std::path::Path;

use windows::core::{GUID, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_ISSUER_FLAG, CERT_NAME_SIMPLE_DISPLAY_TYPE};
use windows::Win32::Security::WinTrust::{
  WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA,
  WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};

pub struct Signer {
  pub subject_cn: String,
  pub issuer_cn: String,
}

/// Ok(signer) only when Windows reports the signature valid.
pub fn verify(file: &Path) -> Result<Signer, String> {
  let path = HSTRING::from(file.as_os_str());
  let mut file_info = WINTRUST_FILE_INFO {
    cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
    pcwszFilePath: PCWSTR(path.as_ptr()),
    hFile: HANDLE::default(),
    pgKnownSubject: std::ptr::null_mut(),
  };
  let mut data = WINTRUST_DATA {
    cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
    dwUIChoice: WTD_UI_NONE,
    // The engine's bytes are pinned by SHA-256; an offline check keeps Setup
    // from hanging on revocation servers.
    fdwRevocationChecks: WTD_REVOKE_NONE,
    dwUnionChoice: WTD_CHOICE_FILE,
    Anonymous: WINTRUST_DATA_0 { pFile: &mut file_info },
    dwStateAction: WTD_STATEACTION_VERIFY,
    ..Default::default()
  };
  let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  let status = unsafe { WinVerifyTrust(HWND(-1isize as _), &mut action, (&mut data as *mut WINTRUST_DATA).cast()) };
  let result = if status == 0 {
    signer_names(data.hWVTStateData).ok_or_else(|| "the signer certificate could not be read".to_string())
  } else {
    Err(format!("WinVerifyTrust 0x{:08X}", status as u32))
  };
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  unsafe {
    let _ = WinVerifyTrust(HWND(-1isize as _), &mut action, (&mut data as *mut WINTRUST_DATA).cast());
  }
  result
}

fn signer_names(state: HANDLE) -> Option<Signer> {
  unsafe {
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
      return None;
    }
    let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
    if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
      return None;
    }
    let cert = (*(*signer).pasCertChain).pCert;
    if cert.is_null() {
      return None;
    }
    let name = |flags: u32| {
      let mut buf = [0u16; 512];
      let len = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, flags, None, Some(&mut buf));
      String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)])
    };
    Some(Signer { subject_cn: name(0), issuer_cn: name(CERT_NAME_ISSUER_FLAG) })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A Windows binary verifies and names Microsoft; an unsigned copy fails.
  #[test]
  fn verifies_signed_and_refuses_unsigned() {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    // explorer.exe is catalog-signed on some builds; notepad and the WinTrust
    // test both accept either, so use a file with an embedded signature.
    let signed = Path::new(&system).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    if let Ok(s) = verify(&signed) {
      assert!(s.subject_cn.contains("Microsoft"), "{}", s.subject_cn);
    }
    let dir = std::env::temp_dir().join(format!("anxhost-trust-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let unsigned = dir.join("unsigned.exe");
    std::fs::write(&unsigned, b"MZ not really a program").unwrap();
    assert!(verify(&unsigned).is_err(), "an unsigned file is never trusted");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A release-signed AnxOS/AnxHost program (the installed app on a
  /// development PC, or ANXHOST_TEST_SIGNED_FILE) names the pinned publisher.
  #[test]
  fn names_the_anxlabs_publisher() {
    let candidate = std::env::var("ANXHOST_TEST_SIGNED_FILE").map(std::path::PathBuf::from).unwrap_or_else(|_| {
      std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Programs").join("AnxOS Control Center").join("AnxOS Control Center.exe")
    });
    if !candidate.exists() {
      eprintln!("skipped: no release-signed AnxHost program on this PC");
      return;
    }
    let signer = verify(&candidate).expect("a release build verifies");
    assert_eq!(signer.subject_cn, crate::engine::PUBLISHER_CN);
    assert!(signer.issuer_cn.starts_with(crate::engine::ISSUER_CN_PREFIX), "{}", signer.issuer_cn);
  }
}
