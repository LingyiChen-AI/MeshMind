//! 窗口 label 常量与 show / hide 的公共动作。

use tauri::{AppHandle, Manager, Runtime};

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
