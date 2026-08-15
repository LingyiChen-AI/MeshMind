//! 系统托盘图标与菜单。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::App;

use crate::{quit, window};

/// 建托盘。
///
/// `hotkey_warning` 是热键注册失败时的说明。不引额外依赖发系统通知的前提下，
/// tooltip 是唯一常驻可见的位置——用户发现热键没反应时，第一反应就是去戳托盘。
pub fn setup(app: &App, hotkey_warning: Option<String>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "快速捕捉", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &capture, &quit])?;

    let tooltip = match hotkey_warning {
        Some(warning) => format!("MeshMind\n⚠ {warning}"),
        None => "MeshMind".to_owned(),
    };

    let mut builder = TrayIconBuilder::new()
        .tooltip(tooltip)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => window::show_and_focus(app, window::MAIN),
            "capture" => window::show_and_focus(app, window::CAPTURE),
            // 不直接 exit：前端的编辑是防抖保存的，立刻退会把最后一次编辑静默吞掉。
            // 走 request_quit 先给前端一个落盘的机会（带 2 秒兜底，见 quit.rs）。
            "quit" => quit::request_quit(app),
            _ => {}
        });

    // 复用应用图标而不是单独准备一套托盘图标：这里少一份需要跟着 rebrand 一起更新的资源。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
