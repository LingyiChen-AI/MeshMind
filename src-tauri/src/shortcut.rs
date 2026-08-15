//! 唤起快捕窗口的全局热键。

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

/// 当前平台的快捕热键，以及给用户看的按键名。
fn capture_hotkey() -> (Shortcut, &'static str) {
    // macOS 上 Cmd+Space 归 Spotlight，Opt+Space 几乎没有系统级占用，是最顺手的空位。
    #[cfg(target_os = "macos")]
    {
        (
            Shortcut::new(Some(Modifiers::ALT), Code::Space),
            "Opt+Space",
        )
    }
    // Windows 上 Alt+Space 是所有窗口的系统菜单（移动/最小化/关闭）的固定入口，
    // 抢过来等于把这个入口从整个桌面上拿掉。多按一个 Shift 避开，Linux 同理从众。
    #[cfg(not(target_os = "macos"))]
    {
        (
            Shortcut::new(Some(Modifiers::ALT.union(Modifiers::SHIFT)), Code::Space),
            "Alt+Shift+Space",
        )
    }
}

/// 注册快捕热键。
///
/// 返回 `Some(提示语)` 表示注册失败——热键被别的应用占了是常态而非异常，
/// 咽下去只会让用户对着一个没反应的按键怀疑软件坏了。调用方负责把这句话
/// 送到用户能看见的地方（当前是托盘 tooltip）。
pub fn register_capture_hotkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let (hotkey, key_name) = capture_hotkey();
    let result = app.global_shortcut().on_shortcut(hotkey, |app, _, event| {
        // 一次按键会发 Pressed 和 Released 两个事件，两个都响应就等于切换两次，
        // 净效果是窗口纹丝不动。
        if event.state == ShortcutState::Pressed {
            window::toggle_capture(app);
        }
    });

    match result {
        Ok(()) => None,
        Err(err) => {
            let message = format!(
                "全局热键 {key_name} 注册失败（{err}），多半已被其他应用占用；\
                 快速捕捉暂时只能从托盘菜单打开。"
            );
            eprintln!("[MeshMind] {message}");
            Some(message)
        }
    }
}
