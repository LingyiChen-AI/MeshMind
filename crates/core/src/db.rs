use std::path::Path;

use rusqlite::Connection;

use crate::error::{CoreError, Result};

/// 迁移脚本按序号排列，下标 + 1 即为该脚本对应的 user_version。
/// 新增迁移只能往数组末尾追加，永不修改已发布的脚本。
const MIGRATIONS: &[&str] = &[
    include_str!("db/migrations/001_init.sql"),
    include_str!("db/migrations/002_settings.sql"),
    include_str!("db/migrations/003_ai.sql"),
];

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

    /// `notes::purge` 靠外键级联清 `note_tags` / `note_attachments`，
    /// 而不是手工 DELETE。级联一旦从 schema 里消失，purge 会静默留下孤儿关联行，
    /// 那些行会让附件永远算「有引用」而不可回收。这条测试直接钉住 schema 的声明。
    #[test]
    fn purge_cascades_are_declared_in_the_schema() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        for table in ["note_tags", "note_attachments"] {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(
                sql.contains("REFERENCES notes (id) ON DELETE CASCADE"),
                "{table} 缺少对 notes 的级联删除:\n{sql}"
            );
        }
    }

    /// 老用户的库停在 001，升级后必须只跑 002 那一条，且已有数据毫发无损。
    /// 这条路径是真实存在的（已发布版本就停在 001），跟「空库一次跑完」不是同一件事。
    #[test]
    fn migrate_upgrades_a_database_that_stopped_at_001() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO notes (uuid, title, body_json, body_text, created_at, updated_at)
             VALUES ('u', 't', '{}', 't', 1, 1)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i32);
        let settings_tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(settings_tables, 1, "002 没有被应用");
        let notes: i64 = conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes, 1, "增量迁移不该动已有数据");
    }

    /// 001 是已发布的脚本，永远不能被改；改了的话老库跑不到它、新库跑得到，
    /// 两边 schema 就此分叉。这条测试钉住「002 只是追加」这个事实。
    #[test]
    fn migration_002_is_append_only() {
        assert!(MIGRATIONS.len() >= 2);
        assert!(
            MIGRATIONS[0].contains("CREATE TABLE notes"),
            "001 的内容被改动了"
        );
        assert!(
            !MIGRATIONS[0].contains("settings"),
            "settings 表被塞进了 001，必须是独立的 002"
        );
        assert!(MIGRATIONS[1].contains("CREATE TABLE settings"));
    }

    /// 重复迁移到最新版是空操作：不会因为再跑一次 002 撞上 "table already exists"。
    #[test]
    fn migrating_twice_does_not_reapply_002() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', 'dark')",
            [],
        )
        .unwrap();

        migrate(&conn).expect("重复迁移不应报错");

        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(value, "dark", "重复迁移不该重建表、清掉数据");
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
            "settings",
            "chunks",
            "chunk_embeddings",
            "embed_queue",
            "chunks_fts",
            "conversations",
            "messages",
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

    /// 停在 002 的老库升级后只跑 003，已有笔记与设置毫发无损。
    #[test]
    fn migrate_upgrades_a_database_that_stopped_at_002() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(MIGRATIONS[1]).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO notes (uuid, title, body_json, body_text, created_at, updated_at)
             VALUES ('u', 't', '{}', 't', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', 'dark')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let notes: i64 = conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes, 1, "增量迁移不该动已有数据");
        let theme: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(theme, "dark");
        let chunks: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'chunks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chunks, 1, "003 没有被应用");
    }

    /// 003 只能是追加，不能改动 001/002。
    #[test]
    fn migration_003_is_append_only() {
        assert_eq!(MIGRATIONS.len(), 3);
        assert!(MIGRATIONS[0].contains("CREATE TABLE notes"));
        assert!(MIGRATIONS[1].contains("CREATE TABLE settings"));
        assert!(!MIGRATIONS[0].contains("chunks"));
        assert!(!MIGRATIONS[1].contains("chunks"));
        assert!(MIGRATIONS[2].contains("CREATE TABLE chunks"));
    }

    /// 硬删除笔记时，块、向量、队列行必须靠外键级联一起消失。
    /// 少了任何一条级联，purge 之后会留下指向不存在笔记的孤儿块，
    /// 而检索的 JOIN 会把它们静默丢掉——表在无声地变大，没人会发现。
    #[test]
    fn ai_tables_cascade_from_notes() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (id, uuid, title, body_json, body_text, created_at, updated_at)
             VALUES (1, 'u', 't', '{}', 't', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (id, note_id, ord, heading, text) VALUES (1, 1, 0, '', 'x')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model, dim, vec)
             VALUES (1, 'm', 1, X'00000000')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embed_queue (note_id, enqueued_at) VALUES (1, 1)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM notes WHERE id = 1", []).unwrap();

        for table in ["chunks", "chunk_embeddings", "embed_queue"] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} 没有随 notes 级联删除");
        }
    }

    /// 删会话必须级联删掉它的消息。
    #[test]
    fn messages_cascade_from_conversations() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (1, 'c', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at)
             VALUES (1, 'user', 'q', 1)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM conversations WHERE id = 1", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
