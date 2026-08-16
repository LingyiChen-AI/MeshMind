//! 设置项的键名白名单与读取辅助。
//!
//! 值的语义解释权在前端（外壳只认字符串），但**键名**归外壳管：settings 表是持久化的，
//! 放任前端写任意 key 进去，几个版本后这张表就会积满拼错的、试验性的、早已没人读的
//! 键值对，而没有任何人敢删——因为无从判断哪个还有用。白名单让这张表的内容始终等于
//! 这份常量列表，读代码就能穷举。

/// 快捕热键的加速键字符串，形如 `"Alt+Space"` / `"Ctrl+Alt+Space"`。
/// 语法见 [`crate::shortcut::ACCELERATOR_SYNTAX`]。
pub const KEY_CAPTURE_HOTKEY: &str = "hotkey.capture";

/// macOS 上是否隐藏 Dock 图标，`"true"` / `"false"`。
pub const KEY_HIDE_DOCK_ICON: &str = "macos.hide_dock_icon";

/// 是否开机自启，`"true"` / `"false"`。
pub const KEY_AUTOSTART: &str = "startup.autostart";

/// AI 总开关，`"true"` / `"false"`。默认关——方案书的「零依赖启动」
/// 意味着不配置 AI 时应用不该有任何网络行为。
pub const KEY_AI_ENABLED: &str = "ai.enabled";
/// `"openai"`（OpenAI 兼容协议）或 `"ollama"`。
pub const KEY_AI_PROVIDER: &str = "ai.provider";
pub const KEY_AI_BASE_URL: &str = "ai.base_url";
/// **只写不读**：`get_settings` 会把这个键从返回值里剔除，换成
/// `ai.api_key_set`。密钥因此不会经 IPC 进入 webview，也不会出现在
/// 前端日志或错误上报里。
pub const KEY_AI_API_KEY: &str = "ai.api_key";
pub const KEY_AI_CHAT_MODEL: &str = "ai.chat_model";
pub const KEY_AI_EMBED_MODEL: &str = "ai.embed_model";
pub const KEY_AI_TOP_K: &str = "ai.top_k";

/// `get_settings` 返回值里代替 `ai.api_key` 的那个键，值为 `"true"` / `"false"`。
/// 它**不在** `ALLOWED_KEYS` 里——前端不能写它，它是读取时由
/// [`crate::commands::redact_settings`] 合成出来的。
pub const KEY_AI_API_KEY_SET: &str = "ai.api_key_set";

/// 允许写入 settings 表的全部键名。
pub const ALLOWED_KEYS: [&str; 10] = [
    KEY_CAPTURE_HOTKEY,
    KEY_HIDE_DOCK_ICON,
    KEY_AUTOSTART,
    KEY_AI_ENABLED,
    KEY_AI_PROVIDER,
    KEY_AI_BASE_URL,
    KEY_AI_API_KEY,
    KEY_AI_CHAT_MODEL,
    KEY_AI_EMBED_MODEL,
    KEY_AI_TOP_K,
];

/// 校验键名。
///
/// 错误里点名具体是哪个 key、并列出合法取值：前端在设置页写错一个字母时，
/// 光说「不允许的 key」还得回来翻源码才知道该写什么。
pub fn ensure_allowed(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        return Ok(());
    }
    Err(format!(
        "不认识的设置项「{key}」，当前只接受: {}",
        ALLOWED_KEYS.join(" / ")
    ))
}

/// 把 settings 里的字符串读成 bool。
///
/// 缺失、读库失败、值不是 `"true"` 一律当 `false`：这三个开关（隐藏 Dock、开机自启）
/// 的默认状态都是「关」，把任何读不明白的情况解释成「关」等于回到默认行为，
/// 是这里唯一不会让用户意外的选择。
pub fn read_bool(conn: &rusqlite::Connection, key: &str) -> bool {
    match meshmind_core::settings::get(conn, key) {
        Ok(value) => value.as_deref() == Some("true"),
        Err(err) => {
            eprintln!("[MeshMind] 读设置项「{key}」失败（按默认值 false 处理）: {err}");
            false
        }
    }
}

/// 把 bool 写回 settings 用的字符串形式。和 [`read_bool`] 成对出现，避免两边各写一份字面量。
pub fn write_bool(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_documented_key() {
        for key in ALLOWED_KEYS {
            assert!(ensure_allowed(key).is_ok(), "{key} 应当被放行");
        }
    }

    /// 白名单存在的理由：拼错的 / 试探性的 key 不能落进持久化的设置表。
    #[test]
    fn rejects_unknown_keys_and_names_the_offender() {
        for key in [
            "",
            "hotkey",
            "hotkey.Capture",
            "hotkey.capture ",
            "startup.autoStart",
            "macos.hide_dock",
            "../../etc/passwd",
        ] {
            let err = ensure_allowed(key).expect_err(&format!("{key:?} 不该被放行"));
            assert!(err.contains(key), "错误里应点名这个 key，实际: {err}");
            assert!(
                err.contains(KEY_CAPTURE_HOTKEY),
                "错误里应列出合法取值，实际: {err}"
            );
        }
    }

    /// 合成键不能进白名单——它是读取时算出来的，让前端写进去只会
    /// 在 settings 表里留下一个永远对不上的幽灵值。
    #[test]
    fn the_synthesised_key_is_not_writable() {
        assert!(ensure_allowed(KEY_AI_API_KEY_SET).is_err());
    }

    #[test]
    fn ai_keys_are_writable() {
        for key in [
            KEY_AI_ENABLED,
            KEY_AI_PROVIDER,
            KEY_AI_BASE_URL,
            KEY_AI_API_KEY,
        ] {
            assert!(ensure_allowed(key).is_ok(), "{key}");
        }
    }

    #[test]
    fn bool_round_trips_through_the_stored_string() {
        assert_eq!(write_bool(true), "true");
        assert_eq!(write_bool(false), "false");
    }
}
