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

/// 回收零引用附件：先删文件再删记录。
///
/// 顺序是刻意的 —— 文件删了记录还在，下次 GC 会重试；
/// 反过来记录没了文件还在，那个文件就永远没人知道该删了。
pub fn collect_garbage(conn: &Connection, root: &Path) -> Result<usize> {
    let orphans = {
        let mut stmt = conn.prepare(
            "SELECT id, sha256, ext FROM attachments a
             WHERE NOT EXISTS (SELECT 1 FROM note_attachments na WHERE na.attachment_id = a.id)",
        )?;
        stmt.query_map([], |row| {
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
