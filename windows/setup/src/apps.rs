//! What is running from the install folder, and stopping the Helper the same
//! way the installed uninstaller does (install-agent-task.ps1 -Mode Stop:
//! servers get their save command and stop, the startup task is kept).

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use windows::core::PWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::detect;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const HELPER_TASK: &str = "AnxOSAgent";

fn image_path(pid: u32) -> Option<String> {
  unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
    let _ = CloseHandle(handle);
    ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
  }
}

/// Process ids whose program lives in `dir` (the app, its helpers, the Agent).
pub fn running_from(dir: &Path) -> Vec<u32> {
  let prefix = format!("{}\\", dir.to_string_lossy().trim_end_matches('\\')).to_ascii_lowercase();
  let me = std::process::id();
  let mut found = vec![];
  unsafe {
    let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return found };
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
    while more {
      let pid = entry.th32ProcessID;
      if pid != me && pid != 0 {
        if let Some(path) = image_path(pid) {
          if path.to_ascii_lowercase().starts_with(&prefix) {
            found.push(pid);
          }
        }
      }
      more = Process32NextW(snapshot, &mut entry).is_ok();
    }
    let _ = CloseHandle(snapshot);
  }
  found
}

/// "Running", "Ready", "Disabled" or None when the Helper is not set up.
pub fn helper_task_state() -> Option<String> {
  let out = Command::new("schtasks.exe")
    .args(["/Query", "/TN", HELPER_TASK, "/FO", "CSV", "/NH"])
    .creation_flags(CREATE_NO_WINDOW)
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  let fields: Vec<&str> = text.lines().next()?.split("\",\"").collect();
  fields.last().map(|s| s.trim_matches(|c| c == '"' || c == '\r').to_string())
}

fn user_id() -> String {
  let domain = std::env::var("USERDOMAIN").unwrap_or_default();
  let user = std::env::var("USERNAME").unwrap_or_default();
  format!("{domain}\\{user}")
}

/// Stops the Helper before the engine replaces its files. Returns a log line.
pub fn stop_helper(install_dir: &Path) -> Result<String, String> {
  let script = install_dir.join("resources").join("install-agent-task.ps1");
  if !script.exists() {
    return Ok("helper stop: no Helper script in this install".into());
  }
  let exe = install_dir.join(detect::APP_EXE);
  let out = Command::new("powershell.exe")
    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
    .arg(&script)
    .arg("-ExecutablePath")
    .arg(&exe)
    .args(["-Mode", "Stop", "-UserId"])
    .arg(user_id())
    .creation_flags(CREATE_NO_WINDOW)
    .output()
    .map_err(|e| format!("The Helper could not be asked to stop ({e})."))?;
  let code = out.status.code().unwrap_or(-1);
  if code == 0 {
    Ok("helper stop: install-agent-task.ps1 -Mode Stop exit 0".into())
  } else {
    // The engine closes what is left after asking it to; the Helper's task
    // stays registered either way.
    Ok(format!("helper stop: install-agent-task.ps1 -Mode Stop exit {code} (the installer closes what is left)"))
  }
}
