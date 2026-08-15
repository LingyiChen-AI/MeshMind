use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::Result;

/// 派生 Serialize 是为了外壳的 Tauri 命令能直接把它返回给前端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: i64,
    pub sha256: String,
    pub ext: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// 附件在附件根目录下的相对路径：按 hash 前两位分片，避免单目录堆几万个文件。
pub fn relative_path(sha256: &str, ext: &str) -> PathBuf {
    PathBuf::from(&sha256[0..2]).join(format!("{sha256}.{ext}"))
}

/// 落盘并登记一个附件。内容相同则复用已有记录，不重复写盘。
pub fn store(
    conn: &Connection,
    root: &Path,
    bytes: &[u8],
    ext: &str,
    now: i64,
) -> Result<Attachment> {
    let sha256: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if let Some(existing) = find_by_sha(conn, &sha256)? {
        return Ok(existing);
    }

    let (width, height) = match imagesize::blob_size(bytes) {
        Ok(size) => (Some(size.width as i64), Some(size.height as i64)),
        Err(_) => (None, None),
    };

    let path = root.join(relative_path(&sha256, ext));
    std::fs::create_dir_all(path.parent().expect("分片路径必有父目录"))?;
    std::fs::write(&path, bytes)?;

    let byte_size = bytes.len() as i64;
    conn.execute(
        "INSERT INTO attachments (sha256, ext, byte_size, width, height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![sha256, ext, byte_size, width, height, now],
    )?;

    Ok(Attachment {
        id: conn.last_insert_rowid(),
        sha256,
        ext: ext.to_string(),
        byte_size,
        width,
        height,
    })
}

fn find_by_sha(conn: &Connection, sha256: &str) -> Result<Option<Attachment>> {
    let found = conn
        .query_row(
            "SELECT id, sha256, ext, byte_size, width, height FROM attachments WHERE sha256 = ?1",
            params![sha256],
            row_to_attachment,
        )
        .optional()?;
    Ok(found)
}

/// 按 id 取附件，供外壳解析出文件路径用。
pub fn get(conn: &Connection, id: i64) -> Result<Option<Attachment>> {
    let found = conn
        .query_row(
            "SELECT id, sha256, ext, byte_size, width, height FROM attachments WHERE id = ?1",
            params![id],
            row_to_attachment,
        )
        .optional()?;
    Ok(found)
}

fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        sha256: row.get(1)?,
        ext: row.get(2)?,
        byte_size: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
    })
}

/// 附件回收的默认宽限期：1 小时（毫秒）。
///
/// 选 1 小时的取舍见 [`collect_garbage_with_grace`] 的注释：
/// 短了会误杀还没保存的笔记里的图，长了则让孤儿文件白占盘。
pub const GC_GRACE_MS: i64 = 60 * 60 * 1_000;

/// 回收零引用附件，默认宽限期版本，供外壳直接调用。
///
/// 这是全仓库唯一一处在核心里读系统时钟的地方，纯粹为了让外壳的调用点保持
/// 两参数签名。需要固定时间（测试、批处理）请走 [`collect_garbage_with_grace`]。
pub fn collect_garbage(conn: &Connection, root: &Path) -> Result<usize> {
    collect_garbage_with_grace(conn, root, crate::now_ms(), GC_GRACE_MS)
}

/// 回收零引用**且**已过宽限期的附件：先删文件再删记录，返回回收条数。
///
/// # 为什么必须有宽限期
///
/// 附件的生命周期是「先落盘、后关联」：
/// 1. 用户粘贴图片 → [`store`] 立刻写盘并插入 `attachments` 行，此刻**没有任何笔记引用它**；
/// 2. 用户继续打字 —— 快捕窗口可能晾几十秒，主窗口是 800ms 防抖；
/// 3. `notes::create` / `notes::update` 才写 `note_attachments` 关联。
///
/// 第 1 步到第 3 步之间，这个附件在「零引用」口径下就是垃圾。若 GC 恰好在这个
/// 窗口里跑过，`attachments` 行会被删掉。
///
/// # 不加会怎样
///
/// 随后 `notes::create` 的事务里 `link_attachments` 要写 `note_attachments`，
/// 而该表的 `attachment_id` 有 `REFERENCES attachments(id)` 外键、且
/// `PRAGMA foreign_keys = ON`。注意 SQLite 的 `INSERT OR IGNORE` **救不了这个**：
/// 官方文档明写 "The ON CONFLICT algorithm does not apply to FOREIGN KEY constraints"。
/// 于是外键失败 → **整个事务回滚 → 笔记根本没存进去**，用户只会看到一句
/// 「附件不存在: 42」，而刚写的正文全没了。丢一张图是小事，丢整条笔记不是。
///
/// # 宽限期长度的取舍
///
/// [`GC_GRACE_MS`] 取 1 小时：足以覆盖「快捕窗口开着晾一会儿」和「主窗口写长笔记」
/// 这两种真实场景，又不至于让孤儿文件堆太久（下一轮 GC 照样收）。
/// 宽限期兜不住的极端情况（挂机数小时后才保存）由 `link_attachments` 的
/// 存在性校验兜底，至少给出可读错误而不是裸的外键报错。
///
/// # 边界语义
///
/// 截止点是 `now - grace_ms`，只回收 `created_at < 截止点` 的附件；
/// `created_at` 恰好等于截止点时**仍受保护**（宽限期按闭区间算）。
/// 边界一律从宽 —— 差一毫秒的代价是丢一整条笔记。
///
/// 删除顺序是刻意的 —— 文件删了记录还在，下次 GC 会重试；
/// 反过来记录没了文件还在，那个文件就永远没人知道该删了。
pub fn collect_garbage_with_grace(
    conn: &Connection,
    root: &Path,
    now: i64,
    grace_ms: i64,
) -> Result<usize> {
    // 时钟回拨或宽限期大得离谱时 now - grace 可能下溢，饱和减法保证不 panic：
    // 截止点变成 i64::MIN，等价于「谁都不回收」，正是保守的那一侧。
    let cutoff = now.saturating_sub(grace_ms);
    let orphans = {
        let mut stmt = conn.prepare(
            "SELECT id, sha256, ext FROM attachments a
             WHERE a.created_at < ?1
               AND NOT EXISTS (SELECT 1 FROM note_attachments na WHERE na.attachment_id = a.id)",
        )?;
        stmt.query_map(params![cutoff], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut removed = 0;
    for (id, sha256, ext) in orphans {
        let path = root.join(relative_path(&sha256, &ext));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // 文件已不在，记录照样该清。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        removed += 1;
    }
    Ok(removed)
}
