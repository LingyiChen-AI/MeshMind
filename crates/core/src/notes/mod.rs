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
    // 入队等待向量化。放在同一事务里：笔记写成功而入队失败的话，
    // 会留下一篇永远不被索引的笔记，且没有任何信号能暴露它。
    // 不判断 AI 开关——core 不该知道那件事，而一行队列记录只有几十字节。
    crate::ai::index::enqueue(&tx, id, now)?;
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
    // 逐行切词，行边界同时喂给两张索引表：字面列在行间插哨兵、拼音列在行间插
    // 分隔符。body_text 是各个块用 \n 拼起来的，不隔断的话上一段的末词和下一段的
    // 首词会连成一片，短语查询和连写拼音查询都会跨段落假阳性。
    // 标题永远是单行，走同一条路径不会有哨兵/分隔符产生。
    let title_lines = segment::line_tokens(title);
    let body_lines = segment::line_tokens(body_text);
    let (py_full, py_head) = pinyin::pinyin_index(&body_lines);

    tx.execute(
        "INSERT INTO notes_fts (rowid, title_seg, body_seg) VALUES (?1, ?2, ?3)",
        params![
            id,
            segment::join_with_sentinel(&title_lines).join(" "),
            segment::join_with_sentinel(&body_lines).join(" ")
        ],
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
        params![limit, offset],
    )?;
    for summary in &mut summaries {
        summary.tags = tags::of_note(conn, summary.id)?;
    }
    Ok(summaries)
}

/// 按标签列出未删除的笔记，语义与 [`list`] 完全一致：排除软删除、
/// 按 `updated_at DESC, id DESC` 排序、每条都带上自己的全部标签。
///
/// 标签名走**精确相等**，不做前缀或子串匹配——「论」不该翻出「论文」。
///
/// # 前提：`tag` 必须已经是小写
///
/// 标签入库时由 `tags::parse_tags` 统一转小写，这里直接拿它跟 `tags.name` 比。
/// 调用方传 `"Rust"` 会得到空结果而不是报错——大小写在这一层没有可靠的还原方式
/// （SQLite 的 `lower()` 只认 ASCII），与其在内核里做一半的折叠，不如把
/// 「传小写」定成契约。前端的标签来源本就是 `all_with_counts` 或笔记自带的
/// `tags` 字段，那两处给出的都已经是小写。
pub fn list_by_tag(
    conn: &Connection,
    tag: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<NoteSummary>> {
    let mut summaries = query_summaries(
        conn,
        "SELECT n.id, n.uuid, n.title, n.body_text, n.updated_at
         FROM notes n
         JOIN note_tags nt ON nt.note_id = n.id
         JOIN tags t ON t.id = nt.tag_id
         WHERE t.name = ?1 AND n.deleted_at IS NULL
         ORDER BY n.updated_at DESC, n.id DESC
         LIMIT ?2 OFFSET ?3",
        params![tag, limit, offset],
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
        params![limit, offset],
    )
}

/// 列表查询的公共部分。SQL 必须按 id, uuid, title, body_text, updated_at 取列。
fn query_summaries<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    query_params: P,
) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(sql)?;
    let summaries = stmt
        .query_map(query_params, |row| {
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
    // 正文变了旧向量就过期了，和创建时同样在事务内重新入队。
    crate::ai::index::enqueue(&tx, id, now)?;
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

/// 彻底删除一条已软删除的笔记：连同标签关联、附件关联、索引行一并清除。
///
/// **只接受已软删除的笔记** —— 硬删一条还活着的笔记应当是调用方的 bug，
/// 所以这里返回 [`CoreError::NoteNotDeleted`] 而不是默默照做。删掉的东西找不回来，
/// 这条路径宁可吵闹。笔记压根不存在则是 [`CoreError::NoteNotFound`]，两者分开报，
/// 免得「传错了 id」和「传了活笔记」在界面上长成同一句话。
///
/// `note_tags` / `note_attachments` 靠外键的 `ON DELETE CASCADE` 自动清
/// （见 `001_init.sql`，`purge_cascades_are_declared_in_the_schema` 钉住这条前提）。
/// 索引行在软删除时就已经剔除了，这里再删一次是防御性的：`purge` 未必只被回收站
/// 调用，而一条残留的索引行会让一篇已经不存在的笔记继续出现在搜索结果里，
/// 随后 JOIN 不到 notes——那是比多执行一条 DELETE 昂贵得多的故障。
///
/// # 与附件回收的衔接
///
/// purge 只摘引用，不删文件。被 purge 的笔记若是某个附件的最后一个引用，
/// 该附件即刻变成零引用，但**不会**在这里落盘删除——它要等
/// [`crate::attachments::collect_garbage`] 的下一轮，且必须已过
/// [`crate::attachments::GC_GRACE_MS`]（1 小时）宽限期才会被真正回收。
/// 这正是软删除长期存在的代价所在：软删的笔记一直算「有引用」，附件因此只增不减；
/// 清空回收站是这条链路上唯一能让附件重新可回收的动作。
pub fn purge(conn: &mut Connection, id: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let deleted_at: Option<i64> = tx
        .query_row(
            "SELECT deleted_at FROM notes WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NoteNotFound(id),
            other => CoreError::Db(other),
        })?;
    if deleted_at.is_none() {
        return Err(CoreError::NoteNotDeleted(id));
    }

    delete_index(&tx, id)?;
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// 清空回收站，返回删除条数。
///
/// 逐条走的是和 [`purge`] 相同的清理动作（索引行 + 级联关联），
/// 但整批在同一个事务里完成：清空回收站要么整体生效、要么整体不生效，
/// 不留下「笔记删了索引还在」的中间态。
///
/// 活着的笔记一根毫毛都不碰。附件的后续回收见 [`purge`] 的说明。
pub fn purge_all_deleted(conn: &mut Connection) -> Result<usize> {
    let tx = conn.transaction()?;
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")?;
        stmt.query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    // 索引行按 rowid 逐条删：FTS5 表不是普通表，删不了「所有 rowid 在某集合里」
    // 之外的花样，也享受不到外键级联。
    for id in &ids {
        delete_index(&tx, *id)?;
    }
    let removed = tx.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL", [])?;
    tx.commit()?;
    debug_assert_eq!(removed, ids.len());
    Ok(removed)
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
