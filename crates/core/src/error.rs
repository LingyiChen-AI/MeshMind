use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("文件系统错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库迁移在版本 {version} 失败: {source}")]
    Migration {
        version: i32,
        #[source]
        source: rusqlite::Error,
    },

    #[error("笔记不存在: {0}")]
    NoteNotFound(i64),

    /// 硬删除只接受已在回收站里的笔记。撞上这个错误说明调用方把一条还活着的
    /// 笔记送进了 `notes::purge`，那是调用方的 bug，不是用户的输入问题。
    #[error("笔记未被软删除，不能硬删除: {0}")]
    NoteNotDeleted(i64),

    #[error("附件不存在: {0}")]
    AttachmentNotFound(i64),

    #[error("笔记内容无效: {0}")]
    InvalidContent(String),

    /// AI 配置不完整。带上缺了哪一项——「AI 未配置」这四个字对用户毫无帮助，
    /// 他需要知道到底是 Base URL 没填还是模型名没填。
    #[error("AI 未配置完整，缺少: {0}")]
    AiNotConfigured(String),

    /// 服务返回的结构对不上预期。这不是用户的错，多半是 Base URL 指错了地方
    /// （比如把 Ollama 的地址填进了 OpenAI 模式），所以消息要能提示这一点。
    #[error("AI 服务返回的内容无法解析（请检查 Base URL 与服务商类型是否匹配）: {0}")]
    AiProtocol(String),

    #[error("向量维度不一致: 期望 {expected}，实际 {got}")]
    EmbeddingDimMismatch { expected: usize, got: usize },

    #[error("会话不存在: {0}")]
    ConversationNotFound(i64),
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_not_found_message_contains_id() {
        assert_eq!(CoreError::NoteNotFound(42).to_string(), "笔记不存在: 42");
    }

    #[test]
    fn note_not_deleted_message_is_distinguishable_from_not_found() {
        // 外壳只把 Display 转成字符串给前端，两条消息必须能分辨出来，
        // 否则「清空回收站误传了活笔记」会长得像「笔记不存在」。
        let not_deleted = CoreError::NoteNotDeleted(42).to_string();
        assert_eq!(not_deleted, "笔记未被软删除，不能硬删除: 42");
        assert_ne!(not_deleted, CoreError::NoteNotFound(42).to_string());
    }

    #[test]
    fn invalid_content_message_contains_reason() {
        let e = CoreError::InvalidContent("expected value at line 1".into());
        assert_eq!(e.to_string(), "笔记内容无效: expected value at line 1");
    }

    #[test]
    fn ai_not_configured_names_the_missing_field() {
        // 光说「未配置」用户不知道该填哪一格。
        let e = CoreError::AiNotConfigured("Base URL".into());
        assert!(e.to_string().contains("Base URL"));
    }

    #[test]
    fn ai_protocol_error_hints_at_base_url() {
        let e = CoreError::AiProtocol("missing field `data`".into());
        let message = e.to_string();
        assert!(
            message.contains("Base URL"),
            "解析失败最常见的原因是地址填错，消息要指出来"
        );
        assert!(message.contains("missing field `data`"));
    }

    #[test]
    fn dim_mismatch_reports_both_numbers() {
        let e = CoreError::EmbeddingDimMismatch {
            expected: 1536,
            got: 768,
        };
        let message = e.to_string();
        assert!(message.contains("1536") && message.contains("768"));
    }
}
