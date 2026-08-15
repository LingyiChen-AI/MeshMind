//! 唤起快捕窗口的全局热键。

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

/// 加速键字符串的写法，用在报错里教用户怎么写。
///
/// 语法由 `global-hotkey` 的 `HotKey::from_str` 定义（`tauri-plugin-global-shortcut`
/// 把它原样 re-export 成 `Shortcut`）：修饰键与主键用 `+` 连接，**修饰键必须全部
/// 排在主键前面**，且只允许一个主键——`"Ctrl+Shift+K"` 合法，`"Ctrl+K+Shift"` 不合法。
/// 大小写不敏感。
pub const ACCELERATOR_SYNTAX: &str =
    "修饰键在前、主键在后，用 + 连接，例如 \"CommandOrControl+Shift+K\"；\
     修饰键可用 Command/Cmd/Super、Control/Ctrl、Alt/Option、Shift、CommandOrControl";

/// 当前登记在案的热键。
///
/// 运行时改键必须知道「现在注册的是哪一个」才能把它注销掉——只靠 settings 里的
/// 字符串不够：启动时配置值解析失败会回退到平台默认，那一刻库里的值和实际注册的
/// 热键就对不上了，拿库里的值去注销只会注销一个根本没注册过的键。
#[derive(Default)]
pub struct HotkeyState {
    current: Mutex<Option<Shortcut>>,
}

/// 平台默认的快捕热键，以及给用户看的按键名。
fn capture_hotkey() -> (Shortcut, &'static str) {
    // macOS 上 Cmd+Space 归 Spotlight，Opt+Space 几乎没有系统级占用，是最顺手的空位。
    #[cfg(target_os = "macos")]
    {
        (
            Shortcut::new(Some(Modifiers::ALT), Code::Space),
            "Opt+Space",
        )
    }
    // Windows 上这个位置是被挑剩下的，取舍链条如下：
    // 1. `Alt+Space` 是所有窗口的系统菜单（移动/最小化/关闭）的固定入口，抢过来
    //    等于把这个入口从整个桌面上拿掉；
    // 2. 多按一个 Shift 变成 `Alt+Shift+Space` 又踩进另一个坑——`Alt+Shift` 是
    //    Windows 经典的键盘布局/输入法切换组合，中文 IME 环境下按一次热键很可能
    //    连带把输入法切了，这种「顺手改坏别的东西」比热键不生效更难排查；
    // 3. `Ctrl+Alt+Space` 两个修饰键都不参与 IME 切换，也不是窗口菜单的入口，
    //    是这三者里唯一干净的空位。Linux 无此冲突，但没必要为它多分叉一套按键。
    #[cfg(not(target_os = "macos"))]
    {
        (
            Shortcut::new(Some(Modifiers::CONTROL.union(Modifiers::ALT)), Code::Space),
            "Ctrl+Alt+Space",
        )
    }
}

/// 解析用户配置的加速键，解析不了就退回平台默认。
///
/// 返回 `(热键, 显示名, 可选的警告)`。配置值坏掉时**不**让启动失败：设置是用户
/// 自己敲进去的，也可能是被手工改过的库；为一个错字就让快捕彻底没有热键，
/// 远不如退回默认键再把问题说出来。
fn resolve(configured: Option<&str>) -> (Shortcut, String, Option<String>) {
    let (default, default_name) = capture_hotkey();
    let Some(raw) = configured.map(str::trim).filter(|s| !s.is_empty()) else {
        return (default, default_name.to_owned(), None);
    };
    match Shortcut::from_str(raw) {
        Ok(shortcut) => (shortcut, raw.to_owned(), None),
        Err(err) => (
            default,
            default_name.to_owned(),
            Some(format!(
                "设置里的快捕热键「{raw}」无法解析（{err}），已退回默认键 {default_name}。{ACCELERATOR_SYNTAX}"
            )),
        ),
    }
}

/// 热键被按下时做的事。抽出来是因为启动注册和运行时改键要挂同一个回调。
fn on_pressed<R: Runtime>(app: &AppHandle<R>, event: tauri_plugin_global_shortcut::ShortcutEvent) {
    // 一次按键会发 Pressed 和 Released 两个事件，两个都响应就等于切换两次，
    // 净效果是窗口纹丝不动。
    if event.state == ShortcutState::Pressed {
        window::toggle_capture(app);
    }
}

fn register<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: Shortcut,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| on_pressed(app, event))
}

/// 注册快捕热键并托管 [`HotkeyState`]。
///
/// `configured` 是 settings 里 `hotkey.capture` 的值（没有就传 `None`）。
///
/// 返回 `Some(提示语)` 表示这一轮有话要对用户说——配置值解析失败、或者热键被别的
/// 应用占了。热键注册失败是常态而非异常，咽下去只会让用户对着一个没反应的按键
/// 怀疑软件坏了。调用方负责把这句话送到用户能看见的地方（当前是托盘 tooltip）。
pub fn setup<R: Runtime>(app: &AppHandle<R>, configured: Option<&str>) -> Option<String> {
    app.manage(HotkeyState::default());
    let (shortcut, key_name, parse_warning) = resolve(configured);

    match register(app, shortcut) {
        Ok(()) => {
            *lock(app) = Some(shortcut);
            parse_warning
        }
        Err(err) => {
            let message = format!(
                "全局热键 {key_name} 注册失败（{err}），多半已被其他应用占用；\
                 快速捕捉暂时只能从托盘菜单打开。"
            );
            eprintln!("[MeshMind] {message}");
            // 解析警告和注册警告可能同时存在（配置值坏掉退回默认键，默认键又被占）。
            // 两句都留着：只报后一句会让用户以为自己填的键生效了。
            Some(match parse_warning {
                Some(warning) => format!("{warning} {message}"),
                None => message,
            })
        }
    }
}

fn lock<R: Runtime>(app: &AppHandle<R>) -> std::sync::MutexGuard<'_, Option<Shortcut>> {
    // 这把锁只包住一个 Option<Shortcut> 的读写，中间不调用任何可能 panic 的代码，
    // 中毒实际上只可能来自进程已经处于不可救药的状态。
    app.state::<HotkeyState>()
        .inner()
        .current
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

/// 运行时换一个快捕热键。
///
/// 成功后调用方负责把 `accelerator` 写进 settings；写库失败要调 [`rollback`]。
///
/// 顺序是**先注册新的、再注销旧的**，而不是反过来。反过来的话，新键注册失败
/// （被别的应用占了是最常见的失败原因）时旧键已经没了，用户既按不了新键也按不了
/// 旧键——一个「改键失败」的操作把原本能用的功能也弄没了。按这个顺序，最坏结果
/// 只是改键没生效，旧键始终有效。
pub fn rebind<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let accelerator = accelerator.trim();
    let shortcut = Shortcut::from_str(accelerator)
        .map_err(|err| format!("热键「{accelerator}」无法解析（{err}）。{ACCELERATOR_SYNTAX}"))?;

    let mut current = lock(app);
    if *current == Some(shortcut) {
        // 已经注册的就是它。重复注册同一个热键会被底层判为 AlreadyRegistered 而报错，
        // 但用户的意图（「让这个键生效」）其实已经满足了，不该报错给他看。
        return Ok(());
    }

    register(app, shortcut).map_err(|err| {
        format!(
            "全局热键「{accelerator}」注册失败（{err}），多半已被其他应用占用，\
             请换一个组合；原热键保持不变。"
        )
    })?;

    if let Some(old) = *current {
        if let Err(err) = app.global_shortcut().unregister(old) {
            // 旧键注销失败：新键已经注册上了，两个键同时生效是个坏状态（旧键仍会
            // 弹快捕窗口，用户会以为改键没成功）。把新键撤回来，保持「只有旧键生效」。
            let _ = app.global_shortcut().unregister(shortcut);
            return Err(format!(
                "旧热键 {old} 注销失败（{err}），为避免新旧两个键同时生效，本次改键已撤销。"
            ));
        }
    }

    *current = Some(shortcut);
    Ok(())
}

/// 把热键退回 `previous`，用于「注册成功但写库失败」的回滚。
///
/// 回滚本身也可能失败（旧键在这几毫秒里被别的应用抢走了）。此时没有更好的动作可做：
/// 记一笔日志，把状态清空表示「当前谁都没注册」，让下一次 `rebind` 从干净的前提出发，
/// 而不是拿着一个其实已经失效的旧键去注销。
pub fn rollback<R: Runtime>(app: &AppHandle<R>, previous: Option<Shortcut>) {
    let mut current = lock(app);
    if let Some(now) = current.take() {
        let _ = app.global_shortcut().unregister(now);
    }
    let Some(previous) = previous else {
        return;
    };
    match register(app, previous) {
        Ok(()) => *current = Some(previous),
        Err(err) => eprintln!("[MeshMind] 回滚到原热键 {previous} 失败（{err}），当前无快捕热键"),
    }
}

/// 读一份当前注册的热键，给回滚用。
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Option<Shortcut> {
    *lock(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_platform_default_without_configuration() {
        let (default, default_name) = capture_hotkey();
        for configured in [None, Some(""), Some("   ")] {
            let (shortcut, name, warning) = resolve(configured);
            assert_eq!(shortcut, default, "{configured:?} 应当退回平台默认键");
            assert_eq!(name, default_name);
            assert!(warning.is_none(), "退回默认不该产生警告: {warning:?}");
        }
    }

    #[test]
    fn honours_a_configured_accelerator() {
        let (shortcut, name, warning) = resolve(Some("Ctrl+Shift+K"));
        assert_eq!(
            shortcut,
            Shortcut::new(Some(Modifiers::CONTROL.union(Modifiers::SHIFT)), Code::KeyK)
        );
        assert_eq!(name, "Ctrl+Shift+K");
        assert!(warning.is_none(), "合法配置不该产生警告: {warning:?}");
    }

    /// 坏掉的配置值不能让快捕热键彻底消失——退回默认键，并且必须留下能看懂的话。
    #[test]
    fn reports_and_recovers_from_a_broken_accelerator() {
        let (default, default_name) = capture_hotkey();
        for bad in ["Ctrl+K+Shift", "Ctrl+", "Nope+Space", "Ctrl+NoSuchKey"] {
            let (shortcut, name, warning) = resolve(Some(bad));
            assert_eq!(shortcut, default, "{bad:?} 应当退回平台默认键");
            assert_eq!(name, default_name);
            let warning = warning.unwrap_or_else(|| panic!("{bad:?} 应当带出警告"));
            assert!(warning.contains(bad), "警告里应带上原值，实际: {warning}");
            assert!(
                warning.contains(default_name),
                "警告里应说明退回到了哪个键，实际: {warning}"
            );
        }
    }

    /// `CommandOrControl` 是跨平台写法，两个平台都必须认。
    #[test]
    fn accepts_command_or_control() {
        let (shortcut, _, warning) = resolve(Some("CommandOrControl+Shift+K"));
        assert!(warning.is_none(), "跨平台写法应当被接受: {warning:?}");
        assert_eq!(shortcut.key, Code::KeyK);
        #[cfg(target_os = "macos")]
        assert!(shortcut.mods.contains(Modifiers::SUPER));
        #[cfg(not(target_os = "macos"))]
        assert!(shortcut.mods.contains(Modifiers::CONTROL));
    }
}
