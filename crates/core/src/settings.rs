//! 应用设置的键值存储。
//!
//! **值一律存字符串，类型解释权在调用方。** 内核不该知道「开机自启」是个 bool、
//! 「窗口宽度」是个整数——一旦它知道，每加一个设置项就要往内核加一个类型、一个
//! 解析分支和一套错误处理，而这些语义只有外壳和前端真正拥有。存字符串的代价是
//! 调用方自己 parse，收益是这张表和这三个函数永远不用再改。
//!
//! 键的命名空间同样不归内核管：它不校验 key 的形状，也不预置任何默认值——
//! 「没设过」和「设成了空串」在这里是两件不同的事（前者 `get` 返回 `None`，
//! 后者返回 `Some("")`），默认值该由调用方在读到 `None` 时决定。

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;

/// 读一个设置项。键不存在返回 `None`，而不是空串——见模块注释。
pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value)
}

/// 写一个设置项，已存在则覆盖。
pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 读出全部设置项。
///
/// 用 `BTreeMap` 而非 `HashMap`：迭代顺序按 key 升序固定，前端一次性铺设置面板
/// 时不会每次刷新都换个顺序，测试也能直接比整个 map 而不用先排序。
/// 设置项数量是几十的量级，`BTreeMap` 的查找开销在这里完全不构成问题。
pub fn get_all(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let entries = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn get_returns_none_for_unknown_key() {
        assert_eq!(get(&conn(), "nope").unwrap(), None);
    }

    #[test]
    fn set_then_get() {
        let conn = conn();
        set(&conn, "theme", "dark").unwrap();
        assert_eq!(get(&conn, "theme").unwrap(), Some("dark".into()));
    }

    #[test]
    fn set_overwrites_an_existing_key() {
        let conn = conn();
        set(&conn, "theme", "dark").unwrap();
        set(&conn, "theme", "light").unwrap();
        assert_eq!(get(&conn, "theme").unwrap(), Some("light".into()));
    }

    #[test]
    fn get_all_returns_every_pair_in_key_order() {
        let conn = conn();
        set(&conn, "z", "1").unwrap();
        set(&conn, "a", "2").unwrap();
        let all = get_all(&conn).unwrap();
        assert_eq!(all.keys().collect::<Vec<_>>(), vec!["a", "z"]);
        assert_eq!(all["a"], "2");
        assert_eq!(all["z"], "1");
    }

    #[test]
    fn an_unset_key_and_a_key_set_to_empty_are_different() {
        let conn = conn();
        assert_eq!(get(&conn, "k").unwrap(), None);
        set(&conn, "k", "").unwrap();
        assert_eq!(get(&conn, "k").unwrap(), Some(String::new()));
    }
}
