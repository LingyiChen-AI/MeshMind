//! 对话与消息的持久化。

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::prompt::Citation;
use crate::ai::provider::Message;
use crate::error::{CoreError, Result};

/// 会话标题从首个提问截取的长度。
pub const TITLE_MAX_CHARS: usize = 30;

/// 新会话在拿到第一个提问之前的占位标题。
const UNTITLED: &str = "新对话";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub citations: Vec<Citation>,
    pub created_at: i64,
}

pub fn create_conversation(conn: &Connection, now: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO conversations (title, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![UNTITLED, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_conversations(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at FROM conversations
         ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_conversation(conn: &Connection, id: i64) -> Result<()> {
    // messages 靠外键级联跟着走。
    let n = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(CoreError::ConversationNotFound(id));
    }
    Ok(())
}

pub fn rename_conversation(conn: &Connection, id: i64, title: &str) -> Result<()> {
    let n = conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    if n == 0 {
        return Err(CoreError::ConversationNotFound(id));
    }
    Ok(())
}

pub fn get_messages(conn: &Connection, conversation_id: i64) -> Result<Vec<ChatMessage>> {
    ensure_exists(conn, conversation_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, role, content, citations, created_at FROM messages
         WHERE conversation_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map(params![conversation_id], |r| {
            let raw: String = r.get(3)?;
            Ok(ChatMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                // 坏掉的 citations JSON 不该让整个会话打不开：退化成没有引用，
                // 消息本身还在。这是纯粹的展示信息，不值得为它丢掉正文。
                citations: serde_json::from_str(&raw).unwrap_or_default(),
                created_at: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 喂给模型的历史：只有 role 与 content。
/// citations 是给界面看的，塞进上下文只是白烧 token。
pub fn history_for_prompt(conn: &Connection, conversation_id: i64) -> Result<Vec<Message>> {
    Ok(get_messages(conn, conversation_id)?
        .into_iter()
        .map(|m| Message {
            role: m.role,
            content: m.content,
        })
        .collect())
}

pub fn append_user(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    now: i64,
) -> Result<i64> {
    let id = insert(conn, conversation_id, "user", content, &[], now)?;
    // 首个提问决定标题。之后的提问不再改动——会话每问一次就改名的话，
    // 用户在列表里再也认不出之前那个。
    conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1 AND title = ?3",
        params![
            conversation_id,
            content.chars().take(TITLE_MAX_CHARS).collect::<String>(),
            UNTITLED
        ],
    )?;
    Ok(id)
}

pub fn append_assistant(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    citations: &[Citation],
    now: i64,
) -> Result<i64> {
    insert(conn, conversation_id, "assistant", content, citations, now)
}

fn insert(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &str,
    citations: &[Citation],
    now: i64,
) -> Result<i64> {
    ensure_exists(conn, conversation_id)?;
    let citations =
        serde_json::to_string(citations).map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, citations, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conversation_id, role, content, citations, now],
    )?;
    let id = conn.last_insert_rowid();
    // 顶起 updated_at，否则会话列表的排序永远停在创建时刻。
    conn.execute(
        "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
        params![conversation_id, now],
    )?;
    Ok(id)
}

fn ensure_exists(conn: &Connection, id: i64) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(CoreError::ConversationNotFound(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompt::Citation;
    use crate::db;

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn citation() -> Citation {
        Citation {
            index: 1,
            note_id: 7,
            uuid: "u7".into(),
            title: "标题".into(),
            heading: "小标题".into(),
            excerpt: "片段".into(),
        }
    }

    #[test]
    fn creates_and_lists_conversations_newest_first() {
        let conn = conn();
        let a = create_conversation(&conn, 1_000).unwrap();
        let b = create_conversation(&conn, 2_000).unwrap();
        let list = list_conversations(&conn, 10, 0).unwrap();
        assert_eq!(list.iter().map(|c| c.id).collect::<Vec<_>>(), vec![b, a]);
    }

    /// 标题默认取首个提问的前 N 个字符，且按字符截断。
    #[test]
    fn the_title_defaults_to_the_first_question() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, &"甲".repeat(100), 1_100).unwrap();
        let title = list_conversations(&conn, 10, 0).unwrap()[0].title.clone();
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.chars().all(|c| c == '甲'));
    }

    /// 只有第一条提问决定标题。第二条不该把它改掉，否则会话在列表里
    /// 会随着每次提问改名，用户再也找不到之前那个。
    #[test]
    fn a_later_question_does_not_rename_the_conversation() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "第一问", 1_100).unwrap();
        append_user(&conn, id, "第二问", 1_200).unwrap();
        assert_eq!(list_conversations(&conn, 10, 0).unwrap()[0].title, "第一问");
    }

    #[test]
    fn messages_come_back_in_insertion_order_with_citations_intact() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        append_assistant(&conn, id, "回答", &[citation()], 1_200).unwrap();

        let messages = get_messages(&conn, id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(
            messages[1].citations,
            vec![citation()],
            "citations 的 JSON 往返有损"
        );
    }

    /// 追加消息要顺带把会话的 updated_at 顶上去，否则列表排序永远停在创建时刻。
    #[test]
    fn appending_a_message_bumps_the_conversation_timestamp() {
        let conn = conn();
        let old = create_conversation(&conn, 1_000).unwrap();
        let new = create_conversation(&conn, 2_000).unwrap();
        append_user(&conn, old, "问题", 3_000).unwrap();
        assert_eq!(
            list_conversations(&conn, 10, 0)
                .unwrap()
                .first()
                .unwrap()
                .id,
            old,
            "刚说过话的会话应该排到最前"
        );
        let _ = new;
    }

    /// 供 prompt 使用的历史里**不能带 citations**——那是给界面看的，
    /// 塞进模型上下文只是白白烧 token。
    #[test]
    fn history_for_the_model_carries_only_role_and_content() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        append_assistant(&conn, id, "回答", &[citation()], 1_200).unwrap();

        let history = history_for_prompt(&conn, id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "问题");
        assert_eq!(history[1].content, "回答");
        assert!(!history[1].content.contains("片段"));
    }

    #[test]
    fn deleting_a_conversation_removes_its_messages() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        delete_conversation(&conn, id).unwrap();
        assert!(matches!(
            get_messages(&conn, id),
            Err(CoreError::ConversationNotFound(_))
        ));
        let left: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn operations_on_a_missing_conversation_are_a_named_error() {
        let conn = conn();
        assert!(matches!(
            get_messages(&conn, 999),
            Err(CoreError::ConversationNotFound(999))
        ));
        assert!(matches!(
            append_user(&conn, 999, "问题", 1),
            Err(CoreError::ConversationNotFound(999))
        ));
        assert!(matches!(
            rename_conversation(&conn, 999, "新名"),
            Err(CoreError::ConversationNotFound(999))
        ));
    }

    #[test]
    fn rename_sets_the_title() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        rename_conversation(&conn, id, "新名字").unwrap();
        assert_eq!(list_conversations(&conn, 10, 0).unwrap()[0].title, "新名字");
    }
}
