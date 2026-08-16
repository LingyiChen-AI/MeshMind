//! 块与向量的持久化，以及待向量化队列。

use rusqlite::{Connection, Transaction, params};

use crate::ai::chunk::Chunk;
use crate::ai::vector::{self, VectorIndex};
use crate::error::Result;
use crate::search::segment;

/// 连续失败到这个次数就停止自动重试，等用户在设置面板里手动点「重试」。
/// 无限重试会在服务商返回 401 时把队列变成一台永动机。
pub const MAX_ATTEMPTS: i64 = 5;
/// 退避上限，5 分钟。
pub const BACKOFF_CAP_MS: i64 = 300_000;

/// 一篇笔记的块与它的 FTS 行整体替换。
///
/// 先删后插而不是 diff：块的边界会随正文的任何一次改动整体漂移，
/// 算出「哪几块没变」的成本高于直接重建，而且极易算错。
pub fn replace_chunks(conn: &mut Connection, note_id: i64, chunks: &[Chunk]) -> Result<()> {
    let tx = conn.transaction()?;
    delete_chunks_in(&tx, note_id)?;
    for (ord, chunk) in chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO chunks (note_id, ord, heading, text) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, ord as i64, chunk.heading, chunk.text],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunks_fts (rowid, text_seg) VALUES (?1, ?2)",
            params![id, fts_text(chunk)],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 索引内容 = 标题一行 + 正文一行，行间插哨兵。
///
/// 标题的词必须能命中它下面的块（「部署那一节说了什么」是最自然的问法之一），
/// 但标题末词与正文首词不能连成一个短语——否则「流程先」这种原文里
/// 根本不存在的组合会命中。哨兵的作用与 `notes::write_index` 里完全一致。
fn fts_text(chunk: &Chunk) -> String {
    let lines = if chunk.heading.is_empty() {
        segment::line_tokens(&chunk.text)
    } else {
        segment::line_tokens(&format!("{}\n{}", chunk.heading, chunk.text))
    };
    segment::join_with_sentinel(&lines).join(" ")
}

/// FTS5 表不支持按普通列删除，只能按 rowid 逐行删。
fn delete_chunks_in(tx: &Transaction, note_id: i64) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM chunks WHERE note_id = ?1")?;
        let rows = stmt.query_map(params![note_id], |r| r.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        tx.execute("DELETE FROM chunks_fts WHERE rowid = ?1", params![id])?;
    }
    // chunk_embeddings 靠外键级联跟着走。
    tx.execute("DELETE FROM chunks WHERE note_id = ?1", params![note_id])?;
    Ok(())
}

/// 某篇笔记的全部块，按 ord 排序。
pub fn chunks_of(conn: &Connection, note_id: i64) -> Result<Vec<(i64, Chunk)>> {
    let mut stmt =
        conn.prepare("SELECT id, heading, text FROM chunks WHERE note_id = ?1 ORDER BY ord")?;
    let rows = stmt
        .query_map(params![note_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Chunk {
                    heading: r.get(1)?,
                    text: r.get(2)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 写入一个块的向量。**归一化在这里做**，这是全库唯一的写入口，
/// `vector` 模块「存进来的都是单位向量」这条不变量由它保证。
pub fn write_embedding(conn: &Connection, chunk_id: i64, model: &str, raw: &[f32]) -> Result<()> {
    let mut v = raw.to_vec();
    vector::normalize(&mut v);
    conn.execute(
        "INSERT INTO chunk_embeddings (chunk_id, model, dim, vec) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chunk_id) DO UPDATE SET
           model = excluded.model, dim = excluded.dim, vec = excluded.vec",
        params![chunk_id, model, v.len() as i64, vector::to_blob(&v)],
    )?;
    Ok(())
}

/// 全量装载指定模型的向量。别的模型产生的行直接跳过——
/// 不同模型的向量空间不可比，混在一起算出来的相似度没有意义。
pub fn load_index(conn: &Connection, model: &str, dim: usize) -> Result<VectorIndex> {
    let mut index = VectorIndex::new(model.to_string(), dim);
    let mut stmt = conn
        .prepare("SELECT chunk_id, vec FROM chunk_embeddings WHERE model = ?1 ORDER BY chunk_id")?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (chunk_id, blob) = row?;
        index.upsert(chunk_id, vector::from_blob(&blob));
    }
    Ok(index)
}

pub fn indexed_chunk_count(conn: &Connection, model: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT count(*) FROM chunk_embeddings WHERE model = ?1",
        params![model],
        |r| r.get(0),
    )?;
    Ok(count)
}

pub fn clear_embeddings(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM chunk_embeddings", [])?;
    Ok(())
}

// ---------- 队列 ----------

/// 入队。已在队列里则重置失败状态——用户改了内容重新保存，
/// 说明上一次失败的前提可能已经不成立了，不该继续沿用退避。
pub fn enqueue(conn: &Connection, note_id: i64, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO embed_queue (note_id, enqueued_at, attempts, next_try_at, last_error)
         VALUES (?1, ?2, 0, 0, NULL)
         ON CONFLICT (note_id) DO UPDATE SET
           enqueued_at = excluded.enqueued_at, attempts = 0, next_try_at = 0, last_error = NULL",
        params![note_id, now],
    )?;
    Ok(())
}

/// 把所有未删除的笔记入队。返回入队条数。
pub fn enqueue_all(conn: &Connection, now: i64) -> Result<usize> {
    let n = conn.execute(
        "INSERT INTO embed_queue (note_id, enqueued_at, attempts, next_try_at, last_error)
         SELECT id, ?1, 0, 0, NULL FROM notes WHERE deleted_at IS NULL
         ON CONFLICT (note_id) DO UPDATE SET
           enqueued_at = excluded.enqueued_at, attempts = 0, next_try_at = 0, last_error = NULL",
        params![now],
    )?;
    Ok(n)
}

/// 取出到期的待处理笔记。
pub fn take_due(conn: &Connection, now: i64, limit: usize) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT note_id FROM embed_queue WHERE next_try_at <= ?1 ORDER BY enqueued_at LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![now, limit as i64], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn dequeue(conn: &Connection, note_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM embed_queue WHERE note_id = ?1",
        params![note_id],
    )?;
    Ok(())
}

/// 记一次失败并安排下次重试。用尽次数后把 `next_try_at` 顶到 `i64::MAX`：
/// 行留在队列里（错误信息要给用户看），但不再被 `take_due` 取到。
pub fn record_failure(conn: &Connection, note_id: i64, error: &str, now: i64) -> Result<()> {
    let attempts: i64 = conn.query_row(
        "SELECT attempts FROM embed_queue WHERE note_id = ?1",
        params![note_id],
        |r| r.get(0),
    )?;
    let attempts = attempts + 1;
    let next = if attempts >= MAX_ATTEMPTS {
        i64::MAX
    } else {
        now + (1_000_i64 << attempts).min(BACKOFF_CAP_MS)
    };
    conn.execute(
        "UPDATE embed_queue SET attempts = ?2, next_try_at = ?3, last_error = ?4 WHERE note_id = ?1",
        params![note_id, attempts, next, error],
    )?;
    Ok(())
}

/// 把退避到底的项全部复活。设置面板上的「重试全部」走这里。
pub fn retry_failed(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE embed_queue SET attempts = 0, next_try_at = 0 WHERE attempts >= ?1",
        params![MAX_ATTEMPTS],
    )?;
    Ok(n)
}

pub fn pending_count(conn: &Connection) -> Result<i64> {
    let count = conn.query_row("SELECT count(*) FROM embed_queue", [], |r| r.get(0))?;
    Ok(count)
}

/// 「如果现在启用 AI，会有多少篇笔记要建索引」。**只读**。
///
/// WHERE 子句必须和 `enqueue_all` 的那条逐字一致：这个数字是拿去给用户
/// 做「要不要花这笔钱」的决定的，和实际会被入队的篇数对不上就等于误导。
/// 它不能用 `pending_count` 代替——启用之前队列里通常空空如也，
/// 而那时正是用户最需要知道篇数的时刻。
pub fn indexable_note_count(conn: &Connection) -> Result<i64> {
    let count = conn.query_row(
        "SELECT count(*) FROM notes WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(count)
}

/// 队列里最近一条错误，供设置面板展示。
pub fn last_error(conn: &Connection) -> Result<Option<String>> {
    let value = conn.query_row(
        "SELECT last_error FROM embed_queue
         WHERE last_error IS NOT NULL ORDER BY next_try_at DESC LIMIT 1",
        [],
        |r| r.get(0),
    );
    match value {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::notes::{self, NewNote};

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn note(conn: &mut rusqlite::Connection, text: &str) -> i64 {
        let body = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
        })
        .to_string();
        notes::create(
            conn,
            &NewNote {
                body_json: body,
                attachment_ids: vec![],
            },
            1_000,
        )
        .unwrap()
        .id
    }

    #[test]
    fn replace_chunks_writes_rows_and_fts() {
        let mut conn = conn();
        let id = note(&mut conn, "知识图谱构建方法");
        let chunks = vec![Chunk {
            heading: "方法".into(),
            text: "知识图谱构建方法".into(),
        }];
        replace_chunks(&mut conn, id, &chunks).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks WHERE note_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // FTS 能命中正文里的词。
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '知识'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// 小标题里的词也要能命中它下面的块——否则「在『部署』那一节里说了什么」
    /// 这种再自然不过的问法一条都召回不到。
    #[test]
    fn fts_matches_words_from_the_heading() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "部署流程".into(),
                text: "先构建镜像".into(),
            }],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '部署'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// 标题末词与正文首词之间必须有哨兵隔开，否则「流程先」这种
    /// 根本不存在的短语会命中。
    #[test]
    fn heading_and_body_do_not_form_a_phrase() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "部署流程".into(),
                text: "先构建镜像".into(),
            }],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                r#"SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '"流程 先"'"#,
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0, "标题与正文之间缺少行边界哨兵");
    }

    /// 重切块必须先清干净：旧块留着的话，一篇笔记会同时命中新旧两份内容。
    ///
    /// 查询词取「旧版」而不是整串「旧内容」：索引列里存的是 jieba 切完
    /// 空格分隔的 token，而 unicode61 会把查询串里连着的汉字当成**一个** token，
    /// 拿整串去 MATCH 永远是 0 命中——那样这条断言不管实现对错都成立。
    #[test]
    fn replace_chunks_removes_the_previous_rows_and_fts() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "".into(),
                text: "旧版接口".into(),
            }],
        )
        .unwrap();
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "".into(),
                text: "新版接口".into(),
            }],
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let stale: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '旧版'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "旧的 FTS 行没有被删掉");
    }

    /// 向量写入前必须归一化。跳过这一步的话，检索时的点积就不再是余弦，
    /// 长文本块会仅仅因为模长大而排到前面。
    #[test]
    fn write_embedding_normalizes_before_storing() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "".into(),
                text: "x".into(),
            }],
        )
        .unwrap();
        let chunk_id: i64 = conn
            .query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0))
            .unwrap();

        write_embedding(&conn, chunk_id, "m", &[3.0, 4.0]).unwrap();

        let blob: Vec<u8> = conn
            .query_row(
                "SELECT vec FROM chunk_embeddings WHERE chunk_id = ?1",
                [chunk_id],
                |r| r.get(0),
            )
            .unwrap();
        let v = crate::ai::vector::from_blob(&blob);
        assert!((v.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn load_index_skips_rows_from_another_model() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[
                Chunk {
                    heading: "".into(),
                    text: "a".into(),
                },
                Chunk {
                    heading: "".into(),
                    text: "b".into(),
                },
            ],
        )
        .unwrap();
        let ids: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT id FROM chunks ORDER BY id").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        write_embedding(&conn, ids[0], "m1", &[1.0, 0.0]).unwrap();
        write_embedding(&conn, ids[1], "m2", &[0.0, 1.0]).unwrap();

        let index = load_index(&conn, "m1", 2).unwrap();
        assert_eq!(index.len(), 1);
    }

    /// 入队幂等：同一篇笔记连续保存十次，队列里只该有一行。
    #[test]
    fn enqueue_is_idempotent() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        for i in 0..10 {
            enqueue(&conn, id, 1_000 + i).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM embed_queue", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    /// 重新入队要把失败计数清零，否则一篇笔记失败 5 次之后，
    /// 用户就算把内容改对了也永远不会被重试。
    #[test]
    fn enqueue_resets_a_previously_failed_entry() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 1_000).unwrap();
        record_failure(&conn, id, "boom", 2_000).unwrap();
        enqueue(&conn, id, 3_000).unwrap();

        let (attempts, next, err): (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT attempts, next_try_at, last_error FROM embed_queue WHERE note_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(attempts, 0);
        assert_eq!(next, 0);
        assert!(err.is_none());
    }

    /// 退避时间随失败次数增长，且有上限。
    #[test]
    fn backoff_grows_and_is_capped() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();

        let mut previous = 0;
        for round in 0..MAX_ATTEMPTS {
            record_failure(&conn, id, "boom", 0).unwrap();
            let next: i64 = conn
                .query_row(
                    "SELECT next_try_at FROM embed_queue WHERE note_id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            if round + 1 < MAX_ATTEMPTS {
                assert!(next > previous, "第 {round} 轮退避没有变长");
                assert!(next <= BACKOFF_CAP_MS, "退避超过了上限");
                previous = next;
            }
        }
        // 用尽次数后停止自动重试。
        let next: i64 = conn
            .query_row(
                "SELECT next_try_at FROM embed_queue WHERE note_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next, i64::MAX, "失败 {MAX_ATTEMPTS} 次后应停止自动重试");
    }

    /// 还没到重试时间的项不该被取出来。
    #[test]
    fn take_due_respects_next_try_at() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();
        record_failure(&conn, id, "boom", 10_000).unwrap();

        assert!(
            take_due(&conn, 10_500, 4).unwrap().is_empty(),
            "退避期内不该取出"
        );
        assert_eq!(take_due(&conn, 999_999, 4).unwrap(), vec![id]);
    }

    #[test]
    fn retry_failed_resets_every_exhausted_entry() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            record_failure(&conn, id, "boom", 0).unwrap();
        }
        assert!(take_due(&conn, i64::MAX - 1, 4).unwrap().is_empty());

        retry_failed(&conn).unwrap();
        assert_eq!(take_due(&conn, 1, 4).unwrap(), vec![id]);
    }

    #[test]
    fn enqueue_all_notes_skips_the_deleted_ones() {
        let mut conn = conn();
        let alive = note(&mut conn, "活着");
        let dead = note(&mut conn, "删了");
        notes::soft_delete(&mut conn, dead, 2_000).unwrap();
        // 建笔记本身就会入队，先清空，这条测的是 enqueue_all 自己挑了谁。
        conn.execute("DELETE FROM embed_queue", []).unwrap();

        let n = enqueue_all(&conn, 3_000).unwrap();
        assert_eq!(n, 1);
        assert_eq!(take_due(&conn, 4_000, 10).unwrap(), vec![alive]);
    }

    /// 预览给出的篇数就是启用之后真会入队的篇数，回收站里的不算。
    /// 两个数字对不上，确认框上的「将为 N 篇笔记建立索引」就是在骗人。
    #[test]
    fn indexable_note_count_agrees_with_enqueue_all() {
        let mut conn = conn();
        note(&mut conn, "活着");
        let dead = note(&mut conn, "删了");
        notes::soft_delete(&mut conn, dead, 2_000).unwrap();
        conn.execute("DELETE FROM embed_queue", []).unwrap();

        assert_eq!(indexable_note_count(&conn).unwrap(), 1);
        assert_eq!(enqueue_all(&conn, 3_000).unwrap() as i64, 1);
    }

    /// 预览是给「还没决定要不要花这笔钱」的用户看的：它自己一行都不许写。
    /// 拿 `enqueue_all` 的返回值来充数就会踩到这条。
    #[test]
    fn indexable_note_count_writes_nothing() {
        let mut conn = conn();
        note(&mut conn, "活着");
        conn.execute("DELETE FROM embed_queue", []).unwrap();

        assert_eq!(indexable_note_count(&conn).unwrap(), 1);
        assert_eq!(pending_count(&conn).unwrap(), 0, "预览不该把笔记入队");
    }

    #[test]
    fn clear_embeddings_empties_the_table_but_keeps_chunks() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk {
                heading: "".into(),
                text: "x".into(),
            }],
        )
        .unwrap();
        let chunk_id: i64 = conn
            .query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0))
            .unwrap();
        write_embedding(&conn, chunk_id, "m", &[1.0]).unwrap();

        clear_embeddings(&conn).unwrap();

        let embeddings: i64 = conn
            .query_row("SELECT count(*) FROM chunk_embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(embeddings, 0);
        let chunks: i64 = conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunks, 1, "只清向量，块要留着");
    }
}
