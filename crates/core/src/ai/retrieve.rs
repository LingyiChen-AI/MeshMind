//! Hybrid RAG 检索：块级 FTS5 粗筛 + 向量精筛 + RRF 融合。

use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::vector::VectorIndex;
use crate::error::Result;
use crate::search::segment;

/// RRF 的平滑常数，取自原论文。它压平了首位与次位之间的差距，
/// 使得「在一路里排第 1」不至于碾压「在两路里都排第 3」。
pub const RRF_K: f64 = 60.0;
/// 每一路各取多少候选进入融合。
pub const FTS_TOP: usize = 20;
pub const VEC_TOP: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Retrieved {
    pub chunk_id: i64,
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub heading: String,
    pub text: String,
    pub score: f64,
    pub from_fts: bool,
    pub from_vec: bool,
}

/// 一次混合检索。
///
/// `query_vec` 为 `None` 时（AI 未启用、或还没有任何向量）自动退化成纯 FTS。
/// 这条退化路径不是兜底而是常态：首次开启 AI 后索引建完之前，用户就已经能搜了。
pub fn hybrid(
    conn: &Connection,
    index: Option<&VectorIndex>,
    query: &str,
    query_vec: Option<&[f32]>,
    k: usize,
) -> Result<Vec<Retrieved>> {
    let fts = fts_top(conn, query, FTS_TOP)?;
    let vec: Vec<i64> = match (index, query_vec) {
        (Some(index), Some(query_vec)) => index
            .top_k(query_vec, VEC_TOP)
            .into_iter()
            .map(|(id, _)| id)
            .collect(),
        _ => Vec::new(),
    };

    let fts_set: HashSet<i64> = fts.iter().copied().collect();
    let vec_set: HashSet<i64> = vec.iter().copied().collect();

    let mut out = Vec::new();
    for (chunk_id, score) in fuse(&fts, &vec) {
        // 命中的块可能属于一篇已被软删除的笔记：向量索引和 FTS 都不感知删除状态，
        // 过滤只能在这里做。漏掉它意味着用户删掉的内容会从 AI 嘴里说回来。
        let Some(mut hit) = hydrate(conn, chunk_id)? else {
            continue;
        };
        hit.score = score;
        hit.from_fts = fts_set.contains(&chunk_id);
        hit.from_vec = vec_set.contains(&chunk_id);
        out.push(hit);
        if out.len() == k {
            break;
        }
    }
    Ok(out)
}

/// 块级 bm25 粗筛。
fn fts_top(conn: &Connection, query: &str, limit: usize) -> Result<Vec<i64>> {
    let Some(expr) = fts_match(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1
         ORDER BY bm25(chunks_fts), rowid LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![expr, limit as i64], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 构造词袋 OR 表达式。
///
/// **刻意不用 `search::query::literal_match`。** 那个函数产出的是短语
/// （`"知识 图谱" *`），要求词相邻——搜索框里用户敲的是关键词，短语是对的；
/// 但这里的输入是一整个问句，要求「知识 图谱 是 怎么 构建 的」原样相邻，
/// 一条都召回不到。RAG 粗筛要的是尽量宽的召回，排序交给 bm25。
///
/// 先用滤掉单字虚词的 token 集（`的`、`了`、`是` 这类在每篇笔记里都有，
/// 参与 OR 只会把无关内容捞上来）；若全被滤光则退回完整 token 集，
/// 保证「的」这种极端查询至少还有确定的行为。
fn fts_match(query: &str) -> Option<String> {
    let mut tokens = segment::highlight_terms(query);
    if tokens.is_empty() {
        tokens = segment::searchable_tokens(query);
    }
    if tokens.is_empty() {
        return None;
    }
    let quoted: Vec<String> = tokens
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    Some(quoted.join(" OR "))
}

/// Reciprocal Rank Fusion。得分 = Σ 1/(k + 名次)，名次从 1 起。
///
/// 同一路里重复出现的 id 只按第一次的名次计一遍——重复计分会让一个
/// 恰好被切成多块的长笔记霸占整个结果。
pub fn fuse(fts: &[i64], vec: &[i64]) -> Vec<(i64, f64)> {
    let mut scores: BTreeMap<i64, f64> = BTreeMap::new();
    for channel in [fts, vec] {
        let mut seen = HashSet::new();
        for (rank, id) in channel.iter().enumerate() {
            if !seen.insert(*id) {
                continue;
            }
            *scores.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut out: Vec<(i64, f64)> = scores.into_iter().collect();
    // 同分按 id 升序：BTreeMap 已经给了确定的迭代顺序，这里的 tiebreak
    // 只是把它显式写出来，免得日后换成 HashMap 时静默变成不稳定排序。
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    out
}

/// 取块的完整信息。笔记已被软删除时返回 `None`。
fn hydrate(conn: &Connection, chunk_id: i64) -> Result<Option<Retrieved>> {
    let row = conn.query_row(
        "SELECT c.id, c.note_id, n.uuid, n.title, c.heading, c.text
         FROM chunks c JOIN notes n ON n.id = c.note_id
         WHERE c.id = ?1 AND n.deleted_at IS NULL",
        params![chunk_id],
        |r| {
            Ok(Retrieved {
                chunk_id: r.get(0)?,
                note_id: r.get(1)?,
                uuid: r.get(2)?,
                title: r.get(3)?,
                heading: r.get(4)?,
                text: r.get(5)?,
                score: 0.0,
                from_fts: false,
                from_vec: false,
            })
        },
    );
    match row {
        Ok(hit) => Ok(Some(hit)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::chunk::Chunk;
    use crate::ai::index;
    use crate::db;
    use crate::notes::{self, NewNote};

    fn setup() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn note_with(conn: &mut rusqlite::Connection, chunks: &[(&str, &str)]) -> i64 {
        let body = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "占位" }] }]
        })
        .to_string();
        let id = notes::create(
            conn,
            &NewNote {
                body_json: body,
                attachment_ids: vec![],
            },
            1_000,
        )
        .unwrap()
        .id;
        let chunks: Vec<Chunk> = chunks
            .iter()
            .map(|(h, t)| Chunk {
                heading: (*h).into(),
                text: (*t).into(),
            })
            .collect();
        index::replace_chunks(conn, id, &chunks).unwrap();
        id
    }

    /// 问句形式的查询必须能召回——这正是「不能用短语表达式」的理由。
    #[test]
    fn a_question_shaped_query_still_recalls() {
        let mut conn = setup();
        note_with(
            &mut conn,
            &[("", "知识图谱的构建分为实体抽取与关系抽取两步")],
        );
        let hits = hybrid(&conn, None, "知识图谱是怎么构建的？", None, 6).unwrap();
        assert_eq!(hits.len(), 1, "问句形式的查询召回不到，说明用了短语表达式");
    }

    #[test]
    fn returns_nothing_for_a_query_without_searchable_characters() {
        let mut conn = setup();
        note_with(&mut conn, &[("", "内容")]);
        assert!(hybrid(&conn, None, "？？？", None, 6).unwrap().is_empty());
    }

    /// 没有向量时退化成纯 FTS，不报错也不 panic。
    #[test]
    fn degrades_to_fts_only_without_vectors() {
        let mut conn = setup();
        note_with(&mut conn, &[("", "向量检索")]);
        let hits = hybrid(&conn, None, "向量", None, 6).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].from_fts);
        assert!(!hits[0].from_vec);
    }

    /// 软删除的笔记的块必须被过滤掉。漏了这条，用户删掉的东西会从
    /// AI 的嘴里说回来——这是最糟糕的一类 bug。
    #[test]
    fn chunks_of_a_soft_deleted_note_are_filtered_out() {
        let mut conn = setup();
        let id = note_with(&mut conn, &[("", "秘密内容")]);
        assert_eq!(hybrid(&conn, None, "秘密", None, 6).unwrap().len(), 1);

        notes::soft_delete(&mut conn, id, 2_000).unwrap();
        assert!(
            hybrid(&conn, None, "秘密", None, 6).unwrap().is_empty(),
            "回收站里的笔记不该被 AI 检索到"
        );
    }

    #[test]
    fn k_truncates_the_result() {
        let mut conn = setup();
        note_with(
            &mut conn,
            &[
                ("", "检索甲"),
                ("", "检索乙"),
                ("", "检索丙"),
                ("", "检索丁"),
            ],
        );
        assert_eq!(hybrid(&conn, None, "检索", None, 2).unwrap().len(), 2);
    }

    #[test]
    fn hits_carry_the_note_metadata_needed_for_citations() {
        let mut conn = setup();
        let id = note_with(&mut conn, &[("小标题", "正文内容")]);
        let hit = &hybrid(&conn, None, "正文", None, 6).unwrap()[0];
        assert_eq!(hit.note_id, id);
        assert_eq!(hit.heading, "小标题");
        assert_eq!(hit.text, "正文内容");
        assert!(!hit.uuid.is_empty());
        assert!(!hit.title.is_empty());
    }

    // ---------- RRF ----------

    /// 两路都命中的块必须排在只命中一路的前面。这是融合的全部意义。
    #[test]
    fn a_chunk_found_by_both_channels_outranks_one_found_by_only_one() {
        // fts 名次：[10, 20]；向量名次：[20, 30]
        let fused = fuse(&[10, 20], &[20, 30]);
        assert_eq!(fused[0].0, 20, "两路都命中的 20 应当排第一");
    }

    /// 名次靠前得分更高。
    #[test]
    fn earlier_ranks_score_higher() {
        let fused = fuse(&[1, 2, 3], &[]);
        assert_eq!(
            fused.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(fused[0].1 > fused[1].1);
    }

    /// RRF 常数真的参与了计算：把它换掉，同一组输入的得分必须变。
    /// 这条是防「fuse 写成了简单的名次相加」这类退化实现。
    #[test]
    fn the_rrf_constant_actually_affects_the_score() {
        let with_default = fuse(&[1], &[])[0].1;
        let expected = 1.0 / (RRF_K + 1.0);
        assert!(
            (with_default - expected).abs() < 1e-12,
            "得分公式不是 1/(k+rank)"
        );
        // 等价于断言 RRF_K > 1.0（1/(k+1) < 0.5 与之互为充要），
        // 但从实际算出的得分出发，clippy 才不会把它折成常量断言。
        assert!(
            with_default < 0.5,
            "k 取 1 以下会让首位得分爆炸，融合失去意义"
        );
    }

    /// 同一 id 在同一路里出现两次不该被计两遍。
    #[test]
    fn duplicate_ids_within_one_channel_are_counted_once() {
        let fused = fuse(&[7, 7], &[]);
        assert_eq!(fused.len(), 1);
        assert!((fused[0].1 - 1.0 / (RRF_K + 1.0)).abs() < 1e-12);
    }

    /// 同分时按 id 升序，保证结果稳定——否则测试会随机红，
    /// 用户也会看到列表无缘无故重排。
    #[test]
    fn ties_are_broken_deterministically_by_id() {
        assert_eq!(fuse(&[5], &[3])[0].0, 3);
        assert_eq!(fuse(&[3], &[5])[0].0, 3);
    }

    #[test]
    fn fuse_of_two_empty_channels_is_empty() {
        assert!(fuse(&[], &[]).is_empty());
    }
}
