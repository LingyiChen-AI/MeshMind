//! 从 settings 表读出 AI 配置。

use meshmind_core::ai::provider::{AiConfig, Provider};
use meshmind_core::settings as core_settings;
use rusqlite::Connection;

use crate::settings;

/// 喂给模型的片段数。6 条在 500 字/块的粒度下约 3000 字，
/// 对绝大多数模型的上下文都很宽裕，同时不至于把无关内容也塞进去。
pub const DEFAULT_TOP_K: usize = 6;

fn read(conn: &Connection, key: &str) -> String {
    core_settings::get(conn, key)
        .unwrap_or_default()
        .unwrap_or_default()
}

pub fn is_enabled(conn: &Connection) -> bool {
    settings::read_bool(conn, settings::KEY_AI_ENABLED)
}

pub fn load(conn: &Connection) -> AiConfig {
    AiConfig {
        provider: Provider::parse(&read(conn, settings::KEY_AI_PROVIDER)),
        base_url: read(conn, settings::KEY_AI_BASE_URL),
        api_key: read(conn, settings::KEY_AI_API_KEY),
        chat_model: read(conn, settings::KEY_AI_CHAT_MODEL),
        embed_model: read(conn, settings::KEY_AI_EMBED_MODEL),
        // 解析失败或填了 0 一律回落默认值：一个坏掉的数字不该让 AI 整体失灵，
        // 而 top_k = 0 会让检索永远返回空，表现为「模型什么都答不上来」。
        top_k: read(conn, settings::KEY_AI_TOP_K)
            .parse::<usize>()
            .ok()
            .filter(|k| *k > 0)
            .unwrap_or(DEFAULT_TOP_K),
    }
}

/// 配置是否完整；不完整时返回缺的那一项的中文名。
pub fn missing(cfg: &AiConfig) -> Option<&'static str> {
    if cfg.base_url.trim().is_empty() {
        return Some("Base URL");
    }
    if cfg.chat_model.trim().is_empty() {
        return Some("对话模型");
    }
    if cfg.embed_model.trim().is_empty() {
        return Some("Embedding 模型");
    }
    if cfg.provider == Provider::OpenAi && cfg.api_key.trim().is_empty() {
        return Some("API Key");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use meshmind_core::{db, settings as core_settings};

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn configure(conn: &rusqlite::Connection) {
        for (k, v) in [
            (crate::settings::KEY_AI_PROVIDER, "openai"),
            (
                crate::settings::KEY_AI_BASE_URL,
                "https://api.deepseek.com/v1",
            ),
            (crate::settings::KEY_AI_API_KEY, "sk-x"),
            (crate::settings::KEY_AI_CHAT_MODEL, "deepseek-chat"),
            (
                crate::settings::KEY_AI_EMBED_MODEL,
                "text-embedding-3-small",
            ),
        ] {
            core_settings::set(conn, k, v).unwrap();
        }
    }

    #[test]
    fn defaults_are_safe_when_nothing_is_configured() {
        let conn = conn();
        let cfg = load(&conn);
        assert!(!is_enabled(&conn), "AI 默认必须是关的");
        assert_eq!(cfg.top_k, DEFAULT_TOP_K);
        assert!(missing(&cfg).is_some());
    }

    #[test]
    fn loads_every_field() {
        let conn = conn();
        configure(&conn);
        let cfg = load(&conn);
        assert_eq!(cfg.base_url, "https://api.deepseek.com/v1");
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.chat_model, "deepseek-chat");
        assert!(missing(&cfg).is_none());
    }

    /// Ollama 模式不需要密钥，不能因为没填 key 就判定「未配置」。
    #[test]
    fn ollama_does_not_require_an_api_key() {
        let conn = conn();
        configure(&conn);
        core_settings::set(&conn, crate::settings::KEY_AI_PROVIDER, "ollama").unwrap();
        core_settings::set(&conn, crate::settings::KEY_AI_API_KEY, "").unwrap();
        assert!(missing(&load(&conn)).is_none());
    }

    /// top_k 填了垃圾不能让整个 AI 挂掉，回落到默认值即可。
    #[test]
    fn a_garbage_top_k_falls_back_to_the_default() {
        let conn = conn();
        core_settings::set(&conn, crate::settings::KEY_AI_TOP_K, "很多").unwrap();
        assert_eq!(load(&conn).top_k, DEFAULT_TOP_K);
    }

    /// top_k 为 0 会让检索返回空，等于 AI 永远答不出东西——必须兜住。
    #[test]
    fn a_zero_top_k_falls_back_to_the_default() {
        let conn = conn();
        core_settings::set(&conn, crate::settings::KEY_AI_TOP_K, "0").unwrap();
        assert_eq!(load(&conn).top_k, DEFAULT_TOP_K);
    }

    #[test]
    fn missing_names_the_first_empty_field() {
        let conn = conn();
        configure(&conn);
        core_settings::set(&conn, crate::settings::KEY_AI_CHAT_MODEL, "").unwrap();
        assert_eq!(missing(&load(&conn)), Some("对话模型"));
    }
}
