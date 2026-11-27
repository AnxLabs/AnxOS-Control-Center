//! The Setup window: a borderless tao window hosting one WebView2 page
//! (ui.html), driven by messages. Work runs on a thread and reports back
//! through the event loop; nothing waits on a timer.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Icon, WindowBuilder};
use wry::{WebContext, WebViewBuilder};

use crate::detect::{self, Installed, Mode};
use crate::engine::{self, Event as EngineEvent, Options};
use crate::{apps, shell, uninstall};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
  Install,
  Uninstall,
}

enum Ev {
  Js(String),
  Ipc(String),
  Exit(i32),
}

struct Shared {
  busy: bool,
  installed: Option<Installed>,
  options: Options,
  target: PathBuf,
  done_target: Option<PathBuf>,
  cleanup: Vec<PathBuf>,
  exit_code: i32,
}

fn call(proxy: &EventLoopProxy<Ev>, function: &str, value: Value) {
  let _ = proxy.send_event(Ev::Js(format!("setup.{function}({value})")));
}

fn mode_info(installed: Option<&Installed>) -> Value {
  let mode = detect::mode_for(installed, detect::BUILD);
  json!({
    "mode": mode.key(),
    "from": match &mode { Mode::Update { from } => json!(from), Mode::Newer { installed } => json!(installed), _ => Value::Null },
  })
}

fn initial_state(kind: Kind, shared: &Shared) -> Value {
  let installed = shared.installed.as_ref();
  json!({
    "kind": if kind == Kind::Install { "install" } else { "uninstall" },
    "build": detect::BUILD,
    "artifactVersion": detect::ARTIFACT_VERSION,
    "hasEngine": engine::has_engine(),
    "appBytes": engine::APP_BYTES,
    "freeBytes": shell::free_space(&shared.target),
    "target": shared.target.display().to_string(),
    "installed": installed.map(|i| json!({
      "displayName": i.display_name,
      "build": i.build,
      "location": i.location.as_ref().map(|l| l.display().to_string()),
      "allUsers": i.all_users,
    })),
    "helperState": apps::helper_task_state(),
    "noHelper": shared.options.no_helper,
    "dataFolder": uninstall::data_folder().display().to_string(),
    "modeInfo": mode_info(installed),
  })
}

/// Shown before the standard installer appears, when this PC cannot show the
/// Setup window (WebView2 removed or blocked).
fn fallback(kind: Kind, options: &Options) -> i32 {
  let text = "AnxHost Setup needs Microsoft Edge WebView2 to show its window, and it is not available on this PC.\n\nSetup will continue with the standard Windows installer instead. Your servers, settings and data are kept either way.";
  if !shell::message("AnxHost Control Center Setup", text, true) {
    return 1602;
  }
  if kind == Kind::Uninstall {
    let Some(location) = detect::installed().and_then(|i| i.location) else { return 1 };
    // /ANXNOHANDOFF: the uninstaller must not hand back to this window.
    return std::process::Command::new(location.join(detect::UNINSTALLER_EXE))
      .arg("/ANXNOHANDOFF")
      .status()
      .map(|s| s.code().unwrap_or(1))
      .unwrap_or(1);
  }
  let mut log = |_: String| {};
  match engine::prepare(&mut log) {
    Ok(prepared) => {
      // /NCRC: prepare() verified the engine; skip NSIS's slower CRC pass.
      let mut args = vec!["/NCRC".to_string()];
      if options.no_helper {
        args.push("/NOHELPER".to_string());
      }
      engine::nsis_command(&prepared.exe, &args).status().map(|s| s.code().unwrap_or(1)).unwrap_or(1)
    }
    Err(reason) => {
      shell::message("AnxHost Control Center Setup", &reason, false);
      1
    }
  }
}

pub fn run(kind: Kind, options: Options) -> i32 {
  shell::com_init();
  let installed = detect::installed();
  let target = engine::target_dir(&options, installed.as_ref());
  let shared = Arc::new(Mutex::new(Shared {
    busy: false,
    installed,
    options: options.clone(),
    target,
    done_target: None,
    cleanup: vec![],
    exit_code: 0,
  }));
  // The page starts from this state (no script call can arrive before it loads).
  let start = initial_state(kind, &shared.lock().unwrap());
  let html = include_str!("ui.html")
    .replace("{{MARK}}", include_str!(concat!(env!("OUT_DIR"), "/mark.b64")))
    .replace("{{WORD}}", include_str!(concat!(env!("OUT_DIR"), "/word.b64")))
    .replace("{{ICON}}", include_str!(concat!(env!("OUT_DIR"), "/icon.b64")))
    .replace("{{STATE}}", &start.to_string().replace("</", "<\\/"));

  let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
  let proxy = event_loop.create_proxy();
  let window = match WindowBuilder::new()
    .with_title(if kind == Kind::Install { "AnxHost Control Center Setup" } else { "Uninstall AnxHost Control Center" })
    .with_decorations(false)
    .with_undecorated_shadow(true)
    .with_resizable(false)
    .with_visible(false)
    .with_inner_size(LogicalSize::new(820.0, 520.0))
    .with_window_icon(Icon::from_resource(1, None).ok())
    .build(&event_loop)
  {
    Ok(w) => w,
    Err(_) => return fallback(kind, &options),
  };
  if let Some(monitor) = window.current_monitor().or_else(|| window.primary_monitor()) {
    let (m, s, w) = (monitor.position(), monitor.size(), window.outer_size());
    window.set_outer_position(PhysicalPosition::new(m.x + (s.width as i32 - w.width as i32) / 2, m.y + (s.height as i32 - w.height as i32) / 2));
  }
  shell::set_round_corners(window.hwnd());

  let webview_dir = std::env::temp_dir().join(format!("AnxHostSetup-ui-{}", std::process::id()));
  let mut context = WebContext::new(Some(webview_dir.clone()));
  let ipc_proxy = proxy.clone();
  let webview = match WebViewBuilder::new_with_web_context(&mut context)
    .with_html(html)
    .with_background_color((14, 12, 20, 255))
    .with_ipc_handler(move |req| {
      let _ = ipc_proxy.send_event(Ev::Ipc(req.body().clone()));
    })
    .build(&window)
  {
    Ok(w) => w,
    Err(_) => {
      drop(window);
      return fallback(kind, &options);
    }
  };

  if let Ok(mut s) = shared.lock() {
    s.cleanup.push(webview_dir);
  }
  window.set_visible(true);

  event_loop.run(move |event, _, control_flow| {
    *control_flow = ControlFlow::Wait;
    match event {
      Event::UserEvent(Ev::Js(script)) => {
        let _ = webview.evaluate_script(&script);
      }
      Event::UserEvent(Ev::Exit(code)) => {
        shell::delete_after_exit(&shared.lock().map(|s| s.cleanup.clone()).unwrap_or_default());
        *control_flow = ControlFlow::ExitWithCode(code);
      }
      Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
        if !shared.lock().map(|s| s.busy).unwrap_or(false) {
          let code = shared.lock().map(|s| s.exit_code).unwrap_or(0);
          let _ = proxy.send_event(Ev::Exit(code));
        }
      }
      Event::UserEvent(Ev::Ipc(body)) => {
        let message: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        match message["cmd"].as_str().unwrap_or("") {
          "drag" => {
            let _ = window.drag_window();
          }
          "minimize" => window.set_minimized(true),
          "close" => {
            if let Ok(s) = shared.lock() {
              if !s.busy {
                let _ = proxy.send_event(Ev::Exit(s.exit_code));
              }
            }
          }
          "browse" => {
            let start = shared.lock().map(|s| s.target.clone()).unwrap_or_default();
            if let Some(chosen) = shell::pick_folder(window.hwnd(), &start) {
              let target = detect::normalize_location(&chosen);
              if let Ok(mut s) = shared.lock() {
                s.target = target.clone();
              }
              call(&proxy, "target", json!({ "target": target.display().to_string(), "freeBytes": shell::free_space(&target) }));
            }
          }
          "install" => start_install(proxy.clone(), shared.clone(), &message, false),
          "continue" => start_install(proxy.clone(), shared.clone(), &message, true),
          "uninstall" => start_uninstall(proxy.clone(), shared.clone()),
          "open-app" => {
            let exe = shared.lock().ok().and_then(|s| s.done_target.clone()).map(|t| t.join(detect::APP_EXE));
            if let Some(exe) = exe {
              let _ = shell::open_app(&exe);
            }
          }
          "link" => {
            if let Some(url) = message["url"].as_str().filter(|u| u.starts_with("https://")) {
              let _ = std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).spawn();
            }
          }
          _ => {}
        }
      }
      _ => {}
    }
  })
}

fn start_install(proxy: EventLoopProxy<Ev>, shared: Arc<Mutex<Shared>>, message: &Value, confirmed_close: bool) {
  let (options, target, existing) = {
    let Ok(mut s) = shared.lock() else { return };
    if s.busy {
      return;
    }
    if let Some(opts) = message.get("options") {
      s.options.no_helper = !opts["helper"].as_bool().unwrap_or(true);
      s.options.all_users = opts["allUsers"].as_bool().unwrap_or(false);
    }
    // An install keeps its folder and mode; a new one uses the chosen folder.
    let existing = s.installed.as_ref().and_then(|i| i.location.clone());
    if let Some(location) = &existing {
      s.target = location.clone();
      if s.installed.as_ref().map(|i| i.all_users).unwrap_or(false) {
        s.options.all_users = true;
      }
    }
    let target = s.target.clone();
    s.options.dir = Some(target.clone());
    s.busy = true;
    (s.options.clone(), target, existing)
  };

  // Ask before anything that runs from the install folder is closed.
  if !confirmed_close {
    let running = existing.as_ref().map(|dir| apps::running_from(dir)).unwrap_or_default();
    if !running.is_empty() {
      if let Ok(mut s) = shared.lock() {
        s.busy = false;
      }
      call(&proxy, "closeApps", json!({ "processes": running.len(), "helperState": apps::helper_task_state() }));
      return;
    }
  }

  std::thread::spawn(move || {
    let mut log = |line: String| call(&proxy, "log", json!(line));
    call(&proxy, "step", json!("verify"));
    let prepared = match engine::prepare(&mut log) {
      Ok(p) => p,
      Err(reason) => return finish_failed(&proxy, &shared, json!({ "reached": "verify", "what": reason, "nothingChanged": true })),
    };
    call(&proxy, "step", json!("stop-helper"));
    if let Some(dir) = &existing {
      if apps::helper_task_state().as_deref() == Some("Running") {
        match apps::stop_helper(dir) {
          Ok(line) | Err(line) => log(line),
        }
      } else {
        log("helper stop: not running".into());
      }
    }
    let status = prepared.dir.join("status.txt");
    let result = engine::run(&prepared.exe, &options, &target, &status, &mut |event| match event {
      EngineEvent::Step(step) => call(&proxy, "step", json!(step)),
      EngineEvent::Copy { fraction, bytes } => call(&proxy, "copy", json!({ "fraction": fraction, "bytes": bytes })),
      EngineEvent::Log(line) => call(&proxy, "log", json!(line)),
    });
    let temp = prepared.dir.clone();
    drop(prepared);
    let _ = std::fs::remove_dir_all(&temp);
    match result {
      Ok(outcome) if outcome.exit_code == 0 || outcome.exit_code == 3 => {
        if let Ok(mut s) = shared.lock() {
          s.busy = false;
          s.done_target = Some(target.clone());
          s.exit_code = outcome.exit_code;
        }
        call(&proxy, "done", json!({ "helper": outcome.helper, "exitCode": outcome.exit_code, "helperState": apps::helper_task_state() }));
      }
      Ok(outcome) => finish_failed(&proxy, &shared, json!({ "reached": outcome.reached, "code": outcome.exit_code, "nothingChanged": outcome.reached == "close" && existing.is_some() })),
      Err(reason) => finish_failed(&proxy, &shared, json!({ "reached": "close", "what": reason })),
    }
  });
}

fn finish_failed(proxy: &EventLoopProxy<Ev>, shared: &Arc<Mutex<Shared>>, detail: Value) {
  if let Ok(mut s) = shared.lock() {
    s.busy = false;
    s.exit_code = 1;
  }
  call(proxy, "failed", detail);
}

fn start_uninstall(proxy: EventLoopProxy<Ev>, shared: Arc<Mutex<Shared>>) {
  let installed = {
    let Ok(mut s) = shared.lock() else { return };
    if s.busy {
      return;
    }
    s.busy = true;
    s.installed.clone()
  };
  std::thread::spawn(move || {
    let Some(installed) = installed else {
      return finish_failed(&proxy, &shared, json!({ "reached": "uninstall", "what": "AnxHost Control Center is not installed on this PC." }));
    };
    let result = uninstall::run(&installed, &mut |fraction, line| {
      call(&proxy, "uninstallProgress", json!({ "fraction": fraction }));
      if !line.is_empty() {
        call(&proxy, "log", json!(line));
      }
    });
    match result {
      Ok(0) => {
        if let Ok(mut s) = shared.lock() {
          s.busy = false;
        }
        call(&proxy, "removed", json!({}));
      }
      Ok(code) => finish_failed(&proxy, &shared, json!({ "reached": "uninstall", "code": code })),
      Err(reason) => finish_failed(&proxy, &shared, json!({ "reached": "uninstall", "what": reason })),
    }
  });
}
