//! 窗口 label 常量与 show / hide 的公共动作。

use tauri::{AppHandle, Manager, RunEvent, Runtime};

/// 与 tauri.conf.json 里的窗口定义一一对应。收敛成常量是为了让拼写错误只可能
/// 出现在这一处，而不是散落在托盘、热键、单实例三个回调里各错一次。
pub const MAIN: &str = "main";
pub const CAPTURE: &str = "capture";

/// 把窗口摆到用户面前。
pub fn show_and_focus<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        eprintln!("[MeshMind] 窗口「{label}」不存在，本次唤起被忽略");
        return;
    };
    // show / set_focus 只会在窗口正在销毁一类的边缘情况下失败，此时没有任何可做的
    // 补救动作，更不该让调用方（托盘菜单、热键回调）因此中断。
    let _ = window.show();
    let _ = window.set_focus();
}

/// 收起指定窗口。
///
/// 与 `show_and_focus` 的「尽力而为、失败即忽略」不同，这里把失败原样抛给调用方：
/// 这条路径服务的是命令层，前端要靠返回值判断窗口是不是真的收起了。窗口不存在时
/// 静默返回成功，前端就会以为自己已经关掉了窗口，而它其实还浮在屏幕最上层。
pub fn hide<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Err(format!("窗口「{label}」不存在，无法收起"));
    };
    window
        .hide()
        .map_err(|err| format!("收起窗口「{label}」失败: {err}"))
}

/// 切换 Dock 图标的显示状态（仅 macOS 有实际效果）。
///
/// `Accessory` 就是「纯菜单栏应用」：Dock 里没有图标，Cmd+Tab 里也切不到它。
/// MeshMind 本来就是常驻托盘、靠热键唤起的形态，对不少用户来说 Dock 上那个图标
/// 只是占位置。代价见 `commands::set_hide_dock_icon` 的文档注释。
///
/// 非 macOS 上是空实现：Windows 的任务栏图标由窗口自己控制（快捕窗口已经
/// `skipTaskbar`），Linux 各桌面环境行为不一，都没有对应的进程级开关。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn set_dock_icon_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if hidden {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        app.set_activation_policy(policy)
            .map_err(|err| format!("切换 Dock 图标显示状态失败: {err}"))?;
    }
    Ok(())
}

/// 快捕窗口的开关：可见就收起，不可见就唤起。
pub fn toggle_capture<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(CAPTURE) else {
        eprintln!("[MeshMind] 快捕窗口「{CAPTURE}」不存在，热键无效");
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        // 读不到可见性时一律按「不可见」处理：多唤起一次已经在前台的窗口没有副作用，
        // 而漏掉唤起会让热键在用户眼里彻底失灵。
        Ok(false) | Err(_) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// `App::run` 的事件回调。
///
/// 目前只接管一件事：macOS 上点 Dock 图标。关主窗口只是隐藏（见 main.rs 的
/// CloseRequested 处理），而 macOS 不会自己把隐藏的窗口拉回来——不接管的话，
/// 用户关掉窗口后点 Dock 图标毫无反应，看上去和应用已经死掉没有区别。
///
/// 非 macOS 上没有任何需要接管的变体，两个参数自然全部用不上。
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    // `RunEvent::Reopen` 在 tauri 2.11.5 里带 `#[cfg(target_os = "macos")]`
    // （app.rs 的 RunEvent 定义），在别的平台上连变体名都不存在，所以整条分支
    // 必须跟着 cfg 走。另外 `RunEvent` 是 `#[non_exhaustive]`，这里用 if let 而
    // 不是 match：既天然容纳未来新增的变体，也不会在非 macOS 上退化成一个只剩
    // `_ => {}` 的空 match。
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        // 刻意忽略 `has_visible_windows`：它统计的是「任意可见窗口」，快捕窗口
        // 浮在屏幕上就足以让它为 true，而那时主窗口仍然是隐藏的——恰好是这里要
        // 修的场景。反过来，主窗口本来就在前台时再 show + focus 一次是无副作用的。
        show_and_focus(app, MAIN);
    }
}
