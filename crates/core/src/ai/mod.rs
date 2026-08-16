//! 可插拔 AI 与 Hybrid RAG。
//!
//! **这一层不发网络请求。** `provider` 只负责把配置和输入变成一个 `HttpRequest`
//! 描述，再把响应文本解析成结构化结果；真正的 socket 由 `crates/shell` 持有。
//! 这样服务商协议的每一个字段名、每一种分帧方式都能用普通单测钉住，
//! 不必为了测一个 JSON 的形状去起一台 mock HTTP server。

pub mod chat;
pub mod chunk;
pub mod index;
pub mod prompt;
pub mod provider;
pub mod retrieve;
pub mod vector;

// `AiConfig` 与 `Provider` 尚未定义（Task 6 才写 provider），此处先不导出：
// 提前写 `pub use` 会让整个 crate 编译不过，把后续任务全部卡在门外。
// pub use provider::{AiConfig, Provider};
