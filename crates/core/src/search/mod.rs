pub mod pinyin;
pub mod query;
pub mod segment;

use std::collections::HashSet;

use rusqlite::{Connection, Params, Statement, params};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::notes::tiptap;

/// 拼音索引的两个列名。只在本模块内使用，不接受外部传入，
/// 因此可以安全地拼进 SQL（列名本就不能参数化）。
const PY_FULL: &str = "py_full";
const PY_HEAD: &str = "py_head";

/// trigram 分词器按三字符切分，短于此长度的查询它一个 token 都产不出，
/// 只能退回 LIKE 扫描。
const TRIGRAM_MIN_CHARS: usize = 3;

/// 一条命中是从哪条通道来的。前端据此决定是否给拼音结果加「拼音匹配」标记，
/// 排序上也依赖它：字面命中永远优先于拼音命中。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HitSource {
    Literal,
    PinyinFull,
    PinyinHead,
}

/// 一条检索结果。
///
/// matched_terms 给的是「命中词」而不是 FTS5 的 snippet()：索引列存的是切词后
/// 空格分隔的序列，snippet() 只能在这份序列上取片段，回显出来是「知识 图谱 构建」
/// 这种带空格的坏文本。所以这里把命中词交给前端，由它在原文（body_text）上自己
/// 定位并高亮，显示的始终是用户写下的原始文字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    pub matched_terms: Vec<String>,
    pub source: HitSource,
}

/// 混合检索：字面 → 全拼 → 首字母，三条通道依次执行、先到先得。
///
/// 不做跨通道的分数归一化。字面命中和拼音命中的 bm25 分数量纲不同，硬凑成一个
/// 总分只会得到一个谁也解释不了的排序；而通道本身就是可靠的相关性信号——用户敲
/// 出原字的命中，一定比同音猜测更该排前面。所以按通道分段拼接，段内各自排序。
///
/// 同一篇笔记可能被多条通道命中（正文里既有汉字又有它的拼音），只保留优先级最高
/// 的那一次。
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
    let mut hits = Vec::new();
    let mut seen = HashSet::new();

    // literal_match 返回 None 说明查询里没有任何可检索字符，这一路直接跳过：
    // 发一个空表达式给 FTS5 会匹配到全部记录。
    if let Some(expr) = query::literal_match(query) {
        let terms = segment::segment_tokens(query);
        let rows = literal_rows(conn, &expr, limit)?;
        collect(&mut hits, &mut seen, rows, &terms, HitSource::Literal);
    }

    // 拼音通道只对纯 ASCII 查询开放。含汉字的查询走拼音没有意义，
    // 而且会在拼音列上产生大量假阳性。
    if pinyin::is_ascii_query(query) {
        let normalized = pinyin::normalize_ascii_query(query);
        // 拼音命中没有「词」的概念，高亮词就是归一化后的查询本身。
        let terms = vec![normalized.clone()];
        for (column, source) in [
            (PY_FULL, HitSource::PinyinFull),
            (PY_HEAD, HitSource::PinyinHead),
        ] {
            let rows = pinyin_rows(conn, column, &normalized, limit)?;
            collect(&mut hits, &mut seen, rows, &terms, source);
        }
    }

    // 每条通道各取了 limit 条，拼接后要再截一次。
    hits.truncate(limit as usize);
    Ok(hits)
}

/// 从索引表回捞笔记的原始字段：id、uuid、title、body_text。
type NoteRow = (i64, String, String, String);

fn literal_rows(conn: &Connection, expr: &str, limit: u32) -> Result<Vec<NoteRow>> {
    // bm25 的权重个数必须与 FTS 表的列数一致，否则 SQLite 直接报错。
    // 标题权重高于正文：标题里出现的词更能代表整篇笔记。
    // bm25 返回的是负数且越小越相关，所以是升序而非降序。
    let mut stmt = conn.prepare(
        "SELECT n.id, n.uuid, n.title, n.body_text
         FROM notes_fts f JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 10.0, 1.0)
         LIMIT ?2",
    )?;
    read_rows(&mut stmt, params![expr, limit])
}

fn pinyin_rows(
    conn: &Connection,
    column: &str,
    normalized: &str,
    limit: u32,
) -> Result<Vec<NoteRow>> {
    if normalized.chars().count() >= TRIGRAM_MIN_CHARS {
        let expr = query::pinyin_match(column, normalized);
        let mut stmt = conn.prepare(
            "SELECT n.id, n.uuid, n.title, n.body_text
             FROM notes_py p JOIN notes n ON n.id = p.rowid
             WHERE notes_py MATCH ?1 AND n.deleted_at IS NULL
             ORDER BY rank
             LIMIT ?2",
        )?;
        return read_rows(&mut stmt, params![expr, limit]);
    }

    // 一两个字符的首字母查询（"zs"）在拼音检索里恰恰是最常见的输入，
    // 不能因为 trigram 覆盖不到就当作无结果。退化成全表 LIKE 扫描：
    // 拼音列很短，量级上完全扛得住。
    // 列名不能作为绑定参数，只能格式化进 SQL；它取自本模块常量，不含用户输入。
    let sql = format!(
        "SELECT n.id, n.uuid, n.title, n.body_text
         FROM notes_py p JOIN notes n ON n.id = p.rowid
         WHERE p.{column} LIKE ?1 AND n.deleted_at IS NULL
         ORDER BY n.updated_at DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    read_rows(&mut stmt, params![format!("%{normalized}%"), limit])
}

fn read_rows<P: Params>(stmt: &mut Statement<'_>, params: P) -> Result<Vec<NoteRow>> {
    let rows = stmt
        .query_map(params, |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 把一条通道的结果追加进最终列表，已出现过的 note_id 直接丢弃——
/// 先到的那条来自优先级更高的通道，保留它。
fn collect(
    hits: &mut Vec<SearchHit>,
    seen: &mut HashSet<i64>,
    rows: Vec<NoteRow>,
    matched_terms: &[String],
    source: HitSource,
) {
    for (note_id, uuid, title, body_text) in rows {
        if !seen.insert(note_id) {
            continue;
        }
        hits.push(SearchHit {
            note_id,
            uuid,
            title,
            excerpt: tiptap::excerpt(&body_text),
            matched_terms: matched_terms.to_vec(),
            source,
        });
    }
}
