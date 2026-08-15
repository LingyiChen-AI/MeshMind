pub mod tags;
pub mod tiptap;

use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::search::{pinyin, segment};

/// 新建笔记的输入。标题、纯文本、标签都由 body_json 推导，不重复接收。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNote {
    pub body_json: String,
    pub attachment_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub body_json: String,
    pub body_text: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub attachment_ids: Vec<i64>,
}

/// 列表项，只带渲染笔记流所需的字段，不搬运整份 body_json。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    pub updated_at: i64,
    pub tags: Vec<String>,
}

/// 创建笔记。notes、两张索引表、标签、附件关联在同一事务内写入，
/// 任一环节失败则整体回滚，绝不留下有笔记没索引的中间态。
pub fn create(conn: &mut Connection, new: &NewNote, now: i64) -> Result<Note> {
    let doc: Value = serde_json::from_str(&new.body_json)
        .map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let body_text = tiptap::extract_text(&doc);
    let title = tiptap::derive_title(&body_text);
    let tag_names = tags::parse_tags(&body_text);
    let uuid = Uuid::now_v7().to_string();

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO notes (uuid, title, body_json, body_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![uuid, title, new.body_json, body_text, now],
    )?;
    let id = tx.last_insert_rowid();
    write_index(&tx, id, &title, &body_text)?;
    tags::attach(&tx, id, &tag_names)?;
    link_attachments(&tx, id, &new.attachment_ids)?;
    tx.commit()?;

    let mut sorted_tags = tag_names;
    sorted_tags.sort();
    Ok(Note {
        id,
        uuid,
        title,
        body_json: new.body_json.clone(),
        body_text,
        created_at: now,
        updated_at: now,
        tags: sorted_tags,
        attachment_ids: new.attachment_ids.clone(),
    })
}

/// 写入两张索引表。rowid 与 notes.id 对齐，这样搜索能直接 JOIN 回 notes。
fn write_index(tx: &Transaction, id: i64, title: &str, body_text: &str) -> Result<()> {
    // 逐行切词并在行间插哨兵：body_text 是各个块用 \n 拼起来的，不隔断的话
    // 上一段的末词和下一段的首词会变成相邻 token，短语查询就会跨段落假阳性。
    // 标题永远是单行，走同一个函数不会有哨兵产生。
    let title_tokens = segment::index_tokens(title);
    let body_tokens = segment::index_tokens(body_text);
    // 哨兵不含汉字，pinyin_index 对含非汉字的词整词跳过，因此不会进拼音列。
    let (py_full, py_head) = pinyin::pinyin_index(&body_tokens);

    tx.execute(
        "INSERT INTO notes_fts (rowid, title_seg, body_seg) VALUES (?1, ?2, ?3)",
        params![id, title_tokens.join(" "), body_tokens.join(" ")],
    )?;
    tx.execute(
        "INSERT INTO notes_py (rowid, py_full, py_head) VALUES (?1, ?2, ?3)",
        params![id, py_full, py_head],
    )?;
    Ok(())
}

/// 索引行按 rowid 删除。FTS5 表不支持原地改写，更新一律先删后插。
fn delete_index(tx: &Transaction, id: i64) -> Result<()> {
    tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
    tx.execute("DELETE FROM notes_py WHERE rowid = ?1", params![id])?;
    Ok(())
}

/// 关联附件。插入前先校验附件确实存在。
///
/// 不能只靠外键：`note_attachments.attachment_id` 的外键失败会让整个事务回滚，
/// 而 `INSERT OR IGNORE` 对外键约束不生效（SQLite 文档："The ON CONFLICT algorithm
/// does not apply to FOREIGN KEY constraints"）。裸的外键错误冒到界面上是
/// 「数据库错误: FOREIGN KEY constraint failed」，用户完全不知道发生了什么；
/// 先查一次给出 [`CoreError::AttachmentNotFound`]，至少说清是图没了。
/// （附件为什么会没：见 `attachments::collect_garbage_with_grace` 的宽限期说明。）
fn link_attachments(tx: &Transaction, note_id: i64, attachment_ids: &[i64]) -> Result<()> {
    for attachment_id in attachment_ids {
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM attachments WHERE id = ?1)",
            params![attachment_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(CoreError::AttachmentNotFound(*attachment_id));
        }
        tx.execute(
            "INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?1, ?2)",
            params![note_id, attachment_id],
        )?;
    }
    Ok(())
}

pub fn get(conn: &Connection, id: i64) -> Result<Note> {
    let mut note = conn
        .query_row(
            "SELECT id, uuid, title, body_json, body_text, created_at, updated_at
             FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    title: row.get(2)?,
                    body_json: row.get(3)?,
                    body_text: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    tags: Vec::new(),
                    attachment_ids: Vec::new(),
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NoteNotFound(id),
            other => CoreError::Db(other),
        })?;

    note.tags = tags::of_note(conn, id)?;
    note.attachment_ids = attachment_ids_of(conn, id)?;
    Ok(note)
}

fn attachment_ids_of(conn: &Connection, note_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT attachment_id FROM note_attachments WHERE note_id = ?1 ORDER BY attachment_id",
    )?;
    let ids = stmt
        .query_map(params![note_id], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// 按更新时间倒序列出未删除的笔记。
pub fn list(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<NoteSummary>> {
    let mut summaries = query_summaries(
        conn,
        "SELECT id, uuid, title, body_text, updated_at
         FROM notes WHERE deleted_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT ?1 OFFSET ?2",
        limit,
        offset,
    )?;
    for summary in &mut summaries {
        summary.tags = tags::of_note(conn, summary.id)?;
    }
    Ok(summaries)
}

/// 回收站列表，按删除时间倒序。
pub fn list_deleted(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<NoteSummary>> {
    query_summaries(
        conn,
        "SELECT id, uuid, title, body_text, updated_at
         FROM notes WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, id DESC
         LIMIT ?1 OFFSET ?2",
        limit,
        offset,
    )
}

fn query_summaries(
    conn: &Connection,
    sql: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(sql)?;
    let summaries = stmt
        .query_map(params![limit, offset], |row| {
            let body_text: String = row.get(3)?;
            Ok(NoteSummary {
                id: row.get(0)?,
                uuid: row.get(1)?,
                title: row.get(2)?,
                excerpt: tiptap::excerpt(&body_text),
                updated_at: row.get(4)?,
                tags: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(summaries)
}

/// 全量替换笔记内容。标题、纯文本、标签、索引全部按新内容重算。
pub fn update(
    conn: &mut Connection,
    id: i64,
    body_json: &str,
    attachment_ids: &[i64],
    now: i64,
) -> Result<Note> {
    let doc: Value =
        serde_json::from_str(body_json).map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let body_text = tiptap::extract_text(&doc);
    let title = tiptap::derive_title(&body_text);
    let tag_names = tags::parse_tags(&body_text);

    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET title = ?2, body_json = ?3, body_text = ?4, updated_at = ?5
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, title, body_json, body_text, now],
    )?;
    if changed == 0 {
        return Err(CoreError::NoteNotFound(id));
    }

    delete_index(&tx, id)?;
    write_index(&tx, id, &title, &body_text)?;
    tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
    tags::attach(&tx, id, &tag_names)?;
    tx.execute(
        "DELETE FROM note_attachments WHERE note_id = ?1",
        params![id],
    )?;
    link_attachments(&tx, id, attachment_ids)?;
    tx.commit()?;

    get(conn, id)
}

/// 软删除：置 deleted_at 并剔除索引行。笔记行与附件关联保留，供回收站恢复。
pub fn soft_delete(conn: &mut Connection, id: i64, now: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    if changed == 0 {
        return Err(CoreError::NoteNotFound(id));
    }
    delete_index(&tx, id)?;
    tx.commit()?;
    Ok(())
}

/// 从回收站恢复：清 deleted_at 并按当前内容重建索引。
pub fn restore(conn: &mut Connection, id: i64, now: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let (title, body_text) = tx
        .query_row(
            "SELECT title, body_text FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NoteNotFound(id),
            other => CoreError::Db(other),
        })?;

    tx.execute(
        "UPDATE notes SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    delete_index(&tx, id)?;
    write_index(&tx, id, &title, &body_text)?;
    tx.commit()?;
    Ok(())
}

/// 全量重建两张索引表，返回重建的笔记条数。
/// 索引全部由 notes 派生，因此清空重算永远是安全的。
pub fn rebuild_index(conn: &mut Connection) -> Result<usize> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, title, body_text FROM notes WHERE deleted_at IS NULL ORDER BY id",
        )?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM notes_fts", [])?;
    tx.execute("DELETE FROM notes_py", [])?;
    for (id, title, body_text) in &rows {
        write_index(&tx, *id, title, body_text)?;
    }
    tx.commit()?;
    Ok(rows.len())
}
