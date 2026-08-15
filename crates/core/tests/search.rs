mod common;

use meshmind_core::notes::{self, NewNote};
use meshmind_core::search::{self, HitSource};

use common::{doc, test_conn};

fn seed(conn: &mut rusqlite::Connection, text: &str, now: i64) -> i64 {
    notes::create(
        conn,
        &NewNote {
            body_json: doc(text),
            attachment_ids: vec![],
        },
        now,
    )
    .unwrap()
    .id
}

#[test]
fn finds_note_by_chinese_prefix() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱构建方法", 1_000);
    let hits = search::search(&conn, "知识图", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::Literal);
}

#[test]
fn does_not_match_words_that_are_merely_co_occurring() {
    let mut conn = test_conn();
    seed(&mut conn, "知识管理与图书检索", 1_000);
    let hits = search::search(&conn, "知识图", 10).unwrap();
    assert!(hits.is_empty(), "短语查询不应命中分散出现的词: {hits:?}");
}

#[test]
fn finds_note_by_concatenated_full_pinyin() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    let hits = search::search(&conn, "zhishitupu", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinFull);
}

#[test]
fn finds_note_by_partial_pinyin() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    let hits = search::search(&conn, "tupu", 10).unwrap();
    assert_eq!(hits[0].note_id, id);
}

#[test]
fn finds_note_by_pinyin_initials() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    let hits = search::search(&conn, "zstp", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinHead);
}

#[test]
fn finds_note_by_short_initials_via_like_fallback() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识", 1_000);
    // "zs" 只有两个字符，短于 trigram 的三字符下限，走 LIKE 兜底。
    let hits = search::search(&conn, "zs", 10).unwrap();
    assert_eq!(hits[0].note_id, id);
}

#[test]
fn literal_hits_outrank_pinyin_hits() {
    let mut conn = test_conn();
    let pinyin_only = seed(&mut conn, "图谱", 1_000);
    let literal = seed(&mut conn, "tupu 是拼音", 2_000);
    let hits = search::search(&conn, "tupu", 10).unwrap();
    assert_eq!(hits[0].note_id, literal, "字面命中必须排在拼音命中之前");
    assert_eq!(hits[1].note_id, pinyin_only);
}

#[test]
fn deduplicates_a_note_matched_through_multiple_channels() {
    let mut conn = test_conn();
    seed(&mut conn, "tupu 图谱", 1_000);
    let hits = search::search(&conn, "tupu", 10).unwrap();
    assert_eq!(hits.len(), 1, "同一篇笔记不能因多路命中重复出现");
}

#[test]
fn excludes_deleted_notes() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    notes::soft_delete(&mut conn, id, 2_000).unwrap();
    assert!(search::search(&conn, "知识图", 10).unwrap().is_empty());
}

#[test]
fn returns_matched_terms_for_highlighting() {
    let mut conn = test_conn();
    seed(&mut conn, "北京天安门", 1_000);
    let hits = search::search(&conn, "北京", 10).unwrap();
    assert_eq!(hits[0].matched_terms, vec!["北京".to_string()]);
}

#[test]
fn empty_query_returns_nothing() {
    let mut conn = test_conn();
    seed(&mut conn, "知识图谱", 1_000);
    assert!(search::search(&conn, "   ", 10).unwrap().is_empty());
}

#[test]
fn rebuild_restores_a_wiped_index() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    conn.execute("DELETE FROM notes_fts", []).unwrap();
    conn.execute("DELETE FROM notes_py", []).unwrap();
    assert!(search::search(&conn, "知识图", 10).unwrap().is_empty());

    let rebuilt = notes::rebuild_index(&mut conn).unwrap();

    assert_eq!(rebuilt, 1);
    assert_eq!(search::search(&conn, "知识图", 10).unwrap()[0].note_id, id);
    assert_eq!(
        search::search(&conn, "zhishitupu", 10).unwrap()[0].note_id,
        id
    );
}

#[test]
fn rebuild_skips_deleted_notes() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "已删除的笔记", 1_000);
    notes::soft_delete(&mut conn, id, 2_000).unwrap();
    let rebuilt = notes::rebuild_index(&mut conn).unwrap();
    assert_eq!(rebuilt, 0);
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 0);
}
