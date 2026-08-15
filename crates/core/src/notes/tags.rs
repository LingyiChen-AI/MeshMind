use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{Transaction, params};

use crate::error::Result;

/// `#` 必须位于行首或空白之后，否则 URL 片段（#frag）和 C# 都会被误判成标签。
/// Rust 正则不支持后顾断言，所以把前导边界写进匹配再用捕获组取标签名。
fn tag_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?m)(?:^|\s)#([\p{L}\p{N}_-]+)").unwrap())
}

/// 从正文纯文本解析标签，统一小写，保留首次出现顺序并去重。
pub fn parse_tags(body_text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tag_pattern()
        .captures_iter(body_text)
        .map(|caps| caps[1].to_lowercase())
        .filter(|tag| seen.insert(tag.clone()))
        .collect()
}

/// 把标签写入 tags 并与笔记关联。已存在的标签复用同一行。
pub fn attach(tx: &Transaction, note_id: i64, names: &[String]) -> Result<()> {
    for name in names {
        tx.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![name])?;
        let tag_id: i64 = tx.query_row(
            "SELECT id FROM tags WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;
    }
    Ok(())
}

/// 读取一篇笔记的标签，按名称排序保证输出稳定。
pub fn of_note(conn: &rusqlite::Connection, note_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t
         JOIN note_tags nt ON nt.tag_id = t.id
         WHERE nt.note_id = ?1
         ORDER BY t.name",
    )?;
    let names = stmt
        .query_map(params![note_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chinese_and_latin_tags() {
        assert_eq!(
            parse_tags("今天读了 #论文 和 #machine-learning"),
            vec!["论文", "machine-learning"]
        );
    }

    #[test]
    fn deduplicates_preserving_first_occurrence_order() {
        assert_eq!(parse_tags("#b #a #b"), vec!["b", "a"]);
    }

    #[test]
    fn lowercases_tags() {
        assert_eq!(parse_tags("#Rust #RUST"), vec!["rust"]);
    }

    #[test]
    fn ignores_hash_inside_words() {
        assert!(parse_tags("见 https://x.com/a#frag 与 C#").is_empty());
    }

    #[test]
    fn matches_tag_at_line_start() {
        assert_eq!(parse_tags("第一行\n#标签"), vec!["标签"]);
    }
}
