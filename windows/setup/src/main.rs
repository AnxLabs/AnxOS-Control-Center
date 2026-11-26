//! AnxHost Control Center Setup.
//!
//! - no arguments: the Setup window (fresh install, upgrade from AnxOS Control
//!   Center, update, repair)
//! - `/S`: no window; the embedded engine runs silently with the same options
//!   (`/D=`, `/NOHELPER`, `/allusers`, `/currentuser`, `--updated`,
//!   `--force-run`) and its exit code is returned
//! - `--uninstall`: the uninstall window (the installed copy in resources\ is
//!   started by the NSIS uninstaller for an interactive uninstall);
//!   `--uninstall /S` uninstalls with no window
#![windows_subsystem = "windows"]

mod apps;
mod detect;
mod engine;
mod shell;
mod trust;
mod ui;
mod uninstall;

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let options = engine::Options::from_args(&args);
  let code = if options.silent {
    engine::silent(&options)
  } else if options.uninstall {
    match uninstall::relaunch_from_temp(&args) {
      Some(code) => code,
      None => ui::run(ui::Kind::Uninstall, options),
    }
  } else {
    ui::run(ui::Kind::Install, options)
  };
  std::process::exit(code);
}
