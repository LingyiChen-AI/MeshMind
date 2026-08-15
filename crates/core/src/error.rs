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
}
