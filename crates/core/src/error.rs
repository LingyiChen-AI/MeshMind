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

    #[error("附件不存在: {0}")]
    AttachmentNotFound(i64),

    #[error("笔记内容无效: {0}")]
    InvalidContent(String),
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
    fn invalid_content_message_contains_reason() {
        let e = CoreError::InvalidContent("expected value at line 1".into());
        assert_eq!(e.to_string(), "笔记内容无效: expected value at line 1");
    }
}
