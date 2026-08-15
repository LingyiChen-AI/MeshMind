//! 应用级共享状态：数据库连接与附件目录。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use meshmind_core::db;
use rusqlite::Connection;

/// 数据目录下的固定文件布局。
///
/// 单独抽成一个不依赖 Tauri 的结构，是为了让路径推导能在普通单元测试里验证，
/// 不必启动 `AppHandle` 或伪造 `app_data_dir()`。
pub struct Layout {
    pub db_path: PathBuf,
    pub attachments_root: PathBuf,
}

impl Layout {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            db_path: data_dir.join("meshmind.db"),
            attachments_root: data_dir.join("attachments"),
        }
    }
}

/// 全应用共享的状态，由 Tauri 的 `manage()` 托管。
pub struct AppState {
    /// rusqlite 的 `Connection` 是 `Send` 但不是 `Sync`，要跨命令共享必须加锁。
    /// 个人笔记场景下的并发量（人手动敲字、偶尔搜索）远达不到单连接的瓶颈，
    /// 因此不引入 r2d2/deadpool 之类的连接池——多一个依赖和一层生命周期管理，
    /// 换不到任何实际吞吐。等真的出现并发写竞争再谈池化。
    pub conn: Mutex<Connection>,
    pub attachments_root: PathBuf,
}

impl AppState {
    /// 准备好数据目录：建附件目录、打开数据库、跑迁移。
    pub fn initialize(data_dir: &Path) -> meshmind_core::Result<Self> {
        let layout = Layout::new(data_dir);
        std::fs::create_dir_all(&layout.attachments_root)?;
        // db::open 会自动创建数据库文件的父目录。
        let conn = db::open(&layout.db_path)?;
        db::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            attachments_root: layout.attachments_root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_db_and_attachment_paths_from_data_dir() {
        let layout = Layout::new(std::path::Path::new("/tmp/meshmind"));
        assert_eq!(
            layout.db_path,
            std::path::PathBuf::from("/tmp/meshmind/meshmind.db")
        );
        assert_eq!(
            layout.attachments_root,
            std::path::PathBuf::from("/tmp/meshmind/attachments")
        );
    }

    #[test]
    fn initializes_a_migrated_database() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::initialize(dir.path()).unwrap();
        let conn = state.conn.lock().unwrap();
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 1, "数据库未迁移");
    }
}
