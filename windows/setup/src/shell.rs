//! Small Windows helpers for the Setup window (rounded corners and cleanup
//! after exit come from AnxBrowse's setup).

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, SHCreateItemFromParsingName, IShellItem, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn com_init() {
  unsafe {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
  }
}

pub fn set_round_corners(hwnd: isize) {
  use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
  unsafe {
    let pref = DWMWCP_ROUND;
    let _ = DwmSetWindowAttribute(HWND(hwnd as _), DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const _, std::mem::size_of_val(&pref) as u32);
  }
}

/// The system folder picker, opened on `start`. None when cancelled.
pub fn pick_folder(owner: isize, start: &Path) -> Option<PathBuf> {
  unsafe {
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
    let options = dialog.GetOptions().ok()?;
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
    let mut existing = start.to_path_buf();
    while !existing.exists() {
      if !existing.pop() {
        break;
      }
    }
    if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(HSTRING::from(existing.as_os_str()).as_ptr()), None) {
      let _ = dialog.SetFolder(&item);
    }
    let _ = dialog.SetTitle(&HSTRING::from("Choose where to install AnxHost Control Center"));
    dialog.Show(Some(HWND(owner as _))).ok()?;
    let item = dialog.GetResult().ok()?;
    let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
    let text = path.to_string().ok();
    windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as _));
    text.map(PathBuf::from)
  }
}

/// Free bytes on the drive that holds `path` (or its nearest existing parent).
pub fn free_space(path: &Path) -> Option<u64> {
  let mut existing = path.to_path_buf();
  while !existing.exists() {
    if !existing.pop() {
      return None;
    }
  }
  let mut free = 0u64;
  unsafe { GetDiskFreeSpaceExW(PCWSTR(HSTRING::from(existing.as_os_str()).as_ptr()), Some(&mut free), None, None).ok()? };
  Some(free)
}

/// Opens the installed app as this (signed-in, unelevated) user.
pub fn open_app(exe: &Path) -> Result<(), String> {
  Command::new(exe).current_dir(exe.parent().unwrap_or(Path::new("."))).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Deletes `paths` a few seconds after this process exits (Setup cannot
/// delete its own running exe or its WebView2 folder while it is open).
pub fn delete_after_exit(paths: &[PathBuf]) {
  if paths.is_empty() {
    return;
  }
  let mut script = String::from("ping 127.0.0.1 -n 4 >nul");
  for p in paths {
    let p = p.display().to_string();
    if p.contains('"') || p.len() < 10 {
      continue;
    }
    script.push_str(&format!(" & rmdir /s /q \"{p}\" 2>nul & del /f /q \"{p}\" 2>nul"));
  }
  let _ = Command::new("cmd.exe")
    .raw_arg(format!("/d /c \"{script}\""))
    .creation_flags(CREATE_NO_WINDOW | 0x0000_0008 /* DETACHED_PROCESS */)
    .spawn();
}

/// A native message box: used only when the custom window cannot open.
pub fn message(title: &str, text: &str, ok_cancel: bool) -> bool {
  use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDOK, MB_ICONINFORMATION, MB_OK, MB_OKCANCEL};
  unsafe {
    let answer = MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_ICONINFORMATION | if ok_cancel { MB_OKCANCEL } else { MB_OK });
    answer == IDOK
  }
}
