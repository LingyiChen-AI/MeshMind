use std::path::Path;

use rusqlite::Connection;

use crate::error::{CoreError, Result};

/// 迁移脚本按序号排列，下标 + 1 即为该脚本对应的 user_version。
/// 新增迁移只能往数组末尾追加，永不修改已发布的脚本。
const MIGRATIONS: &[&str] = &[include_str!("db/migrations/001_init.sql")];

/// 打开磁盘数据库，父目录不存在则创建。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// 打开内存数据库，仅供测试使用。
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // journal_mode 会返回一行结果，必须用 execute_batch 而非 pragma_update。
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    Ok(())
}

/// 执行所有尚未应用的迁移。已是最新版本时为空操作。
pub fn migrate(conn: &Connection) -> Result<()> {
    let current: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = index as i32 + 1;
        if version <= current {
            continue;
        }
        conn.execute_batch(sql)
            .map_err(|source| CoreError::Migration { version, source })?;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_in_memory_database() {
        let conn = open_in_memory().unwrap();
        let one: i64 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(one, 1);
    }

    #[test]
    fn sqlite_supports_fts5_with_unicode61() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='unicode61');")
            .expect("bundled SQLite 未启用 FTS5");
    }

    #[test]
    fn sqlite_supports_trigram_tokenizer() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE p USING fts5(b, tokenize='trigram');")
            .expect("SQLite 版本过低，trigram 分词器需要 3.34+");
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_in_memory().unwrap();
        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[test]
    fn migrate_sets_user_version() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i32);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).expect("重复迁移不应报错");
    }

    #[test]
    fn migrate_creates_all_tables() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        for table in [
            "notes",
            "tags",
            "note_tags",
            "attachments",
            "note_attachments",
            "notes_fts",
            "notes_py",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "缺少表 {table}");
        }
    }
}
