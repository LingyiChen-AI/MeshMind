mod common;

use meshmind_core::notes::{self, NewNote};
use meshmind_core::search::{self, HitSource};

use common::{doc, doc_lines, test_conn};

fn seed(conn: &mut rusqlite::Connection, text: &str, now: i64) -> i64 {
    seed_lines(conn, &[text], now)
}

/// 播一篇多段落笔记，每个入参一个段落。
fn seed_lines(conn: &mut rusqlite::Connection, lines: &[&str], now: i64) -> i64 {
    notes::create(
        conn,
        &NewNote {
            body_json: doc_lines(lines),
            attachment_ids: vec![],
        },
        now,
    )
    .unwrap()
    .id
}

fn sources(hits: &[search::SearchHit]) -> Vec<HitSource> {
    hits.iter().map(|h| h.source).collect()
}

fn ids(hits: &[search::SearchHit]) -> Vec<i64> {
    hits.iter().map(|h| h.note_id).collect()
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
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinFull);
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
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinHead);
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
    // 保留下来的必须是优先级最高的那条通道，而不是碰巧先写进 HashSet 的那条。
    assert_eq!(
        hits[0].source,
        HitSource::Literal,
        "去重后保留的应是字面命中"
    );
    assert_eq!(
        hits[0].matched_terms,
        vec!["tupu".to_string()],
        "保留字面命中就该保留它可定位的高亮词"
    );
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

// ---------------------------------------------------------------- limit 截断

#[test]
fn returns_at_most_limit_hits_from_a_single_channel() {
    let mut conn = test_conn();
    for i in 0..12 {
        seed(&mut conn, &format!("知识图谱笔记{i}"), 1_000 + i);
    }
    let hits = search::search(&conn, "知识图", 5).unwrap();
    assert_eq!(hits.len(), 5, "命中 12 条也只能返回 limit 条");
    assert!(hits.iter().all(|h| h.source == HitSource::Literal));
}

#[test]
fn truncates_across_channels_keeping_literal_hits_first() {
    let mut conn = test_conn();
    // 5 条字面命中「tupu」，5 条只能靠拼音命中（正文是汉字「图谱」）。
    let literal: Vec<i64> = (0..5)
        .map(|i| seed(&mut conn, &format!("tupu 记录{i}"), 1_000 + i))
        .collect();
    let pinyin_only: Vec<i64> = ["甲", "乙", "丙", "丁", "戊"]
        .iter()
        .enumerate()
        .map(|(i, suffix)| seed(&mut conn, &format!("图谱{suffix}"), 2_000 + i as i64))
        .collect();

    let hits = search::search(&conn, "tupu", 7).unwrap();

    assert_eq!(hits.len(), 7, "两条通道共 10 条命中，limit=7 必须截断");
    assert_eq!(
        sources(&hits),
        vec![
            HitSource::Literal,
            HitSource::Literal,
            HitSource::Literal,
            HitSource::Literal,
            HitSource::Literal,
            HitSource::PinyinFull,
            HitSource::PinyinFull,
        ],
        "字面命中必须全部排在拼音命中之前，被截掉的只能是拼音那一段"
    );

    let mut head = ids(&hits)[..5].to_vec();
    head.sort_unstable();
    let mut expected = literal.clone();
    expected.sort_unstable();
    assert_eq!(head, expected, "前 5 条应恰好是 5 篇字面命中的笔记");

    for id in &ids(&hits)[5..] {
        assert!(pinyin_only.contains(id), "后两条应来自纯拼音命中的笔记");
    }
}

#[test]
fn a_full_literal_page_suppresses_the_pinyin_channels() {
    let mut conn = test_conn();
    // 字面已凑满 limit 时短路返回；纯拼音的那篇不该挤进来。
    for i in 0..3 {
        seed(&mut conn, &format!("tupu 记录{i}"), 1_000 + i);
    }
    let pinyin_only = seed(&mut conn, "图谱", 5_000);

    let hits = search::search(&conn, "tupu", 3).unwrap();

    assert_eq!(hits.len(), 3);
    assert!(hits.iter().all(|h| h.source == HitSource::Literal));
    assert!(!ids(&hits).contains(&pinyin_only));
}

// ------------------------------------------------------------- bm25 标题加权

#[test]
fn title_hit_outranks_a_body_that_repeats_the_term() {
    let mut conn = test_conn();
    // 正文里堆了 5 次「知识图谱」，但词只出现在正文；
    let body_hit = seed_lines(
        &mut conn,
        &["随手记录", "知识图谱 知识图谱 知识图谱 知识图谱 知识图谱"],
        1_000,
    );
    // 这一篇只在标题命中一次。标题权重必须压过正文的词频。
    let title_hit = seed_lines(&mut conn, &["知识图谱", "另外记了些别的东西"], 2_000);

    let hits = search::search(&conn, "知识图", 10).unwrap();

    assert_eq!(hits.len(), 2);
    assert_eq!(
        hits[0].note_id, title_hit,
        "标题命中必须排在正文高频命中之前（bm25 标题权重失效时这里会翻过来）"
    );
    assert_eq!(hits[1].note_id, body_hit);
}

// -------------------------------------------------------- FTS5 元字符不炸库

#[test]
fn hostile_queries_never_produce_a_sqlite_syntax_error() {
    let mut conn = test_conn();
    seed_lines(&mut conn, &["知识图谱", "C++ 与 C# 的 (a) 用法"], 1_000);

    // 这些字符在 FTS5 表达式里都有语法含义。任何一个漏进 MATCH 表达式，
    // 用户看到的都不是「没有结果」而是一个硬报错弹窗。
    let hostile = [
        "\"",
        "\"\"",
        "a\"b",
        "*",
        "**",
        "{",
        "}",
        "{a}",
        ":",
        "a:b",
        "^",
        "^a",
        "AND",
        "OR",
        "NOT",
        "NEAR",
        "a AND b",
        "NEAR(a b)",
        "c++",
        "c#",
        "\\",
        "\\\\",
        "(a)",
        "(",
        ")",
        "-",
        "a-b",
        "+",
        "知识 AND 图谱",
        "😀",
        "😀 知识",
        "知识\"图谱",
        "'; DROP TABLE notes; --",
        "%",
        "_",
        "%_%",
    ];
    for query in hostile {
        let result = search::search(&conn, query, 10);
        assert!(
            result.is_ok(),
            "敌意查询 {query:?} 触发了错误: {:?}",
            result.err()
        );
    }
}

// --------------------------------------------------------------- 跨段落邻接

#[test]
fn phrase_does_not_span_a_paragraph_boundary() {
    let mut conn = test_conn();
    seed_lines(
        &mut conn,
        &["标题行", "第一段讲知识", "图谱是第二段"],
        1_000,
    );

    // 「知识」在第二段末尾、「图谱」在第三段开头，语义上毫无关系。
    let hits = search::search(&conn, "知识图谱", 10).unwrap();
    assert!(hits.is_empty(), "短语不得跨段落命中: {hits:?}");

    // 「标题」「行」跨的是标题行与正文段落的边界，同样不算相邻。
    let hits = search::search(&conn, "标题行第一段", 10).unwrap();
    assert!(hits.is_empty(), "短语不得跨段落命中: {hits:?}");
}

#[test]
fn phrase_still_matches_inside_one_paragraph() {
    let mut conn = test_conn();
    let id = seed_lines(
        &mut conn,
        &["标题行", "第一段讲知识图谱", "第二段讲别的"],
        1_000,
    );

    // 同一段内相邻，必须照常命中——哨兵不能把正常的邻接一起打断。
    for query in ["知识图谱", "讲知识", "知识图"] {
        let hits = search::search(&conn, query, 10).unwrap();
        assert_eq!(hits.len(), 1, "{query} 应命中: {hits:?}");
        assert_eq!(hits[0].note_id, id);
        assert_eq!(hits[0].source, HitSource::Literal);
    }
}

#[test]
fn the_line_sentinel_is_never_exposed_as_a_query_or_a_term() {
    let mut conn = test_conn();
    seed_lines(&mut conn, &["第一段", "第二段", "第三段"], 1_000);

    // 直接搜哨兵字符不应把所有多段落笔记翻出来。
    let hits = search::search(&conn, "ʬ", 10).unwrap();
    assert!(hits.is_empty(), "哨兵不该成为可用查询: {hits:?}");

    // 它也不能混进任何一条结果的高亮词。
    let hits = search::search(&conn, "第一段", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].matched_terms.iter().all(|t| t != "ʬ"));
}

// ------------------------------------------------------- matched_terms 契约

#[test]
fn matched_terms_contain_no_punctuation() {
    let mut conn = test_conn();
    seed(&mut conn, "北京，天安门", 1_000);

    let hits = search::search(&conn, "北京，天安门", 10).unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].matched_terms, vec!["北京", "天安门"]);
    for term in &hits[0].matched_terms {
        assert!(
            term.chars().any(char::is_alphanumeric),
            "高亮词 {term:?} 不含字母数字，前端会拿它刷亮全文的标点"
        );
    }
}

#[test]
fn every_matched_term_can_be_located_in_the_returned_text() {
    let mut conn = test_conn();
    seed_lines(&mut conn, &["北京天安门", "去了 Tauri 大会，很好"], 1_000);

    for query in ["北京", "北京天安门", "Tauri", "很好！"] {
        let hits = search::search(&conn, query, 10).unwrap();
        assert_eq!(hits.len(), 1, "{query} 应命中");
        let hit = &hits[0];
        assert!(
            !hit.matched_terms.is_empty(),
            "{query} 的字面命中应有高亮词"
        );
        for term in &hit.matched_terms {
            assert!(
                hit.title.contains(term.as_str()) || hit.excerpt.contains(term.as_str()),
                "高亮词 {term:?} 在 title({:?}) / excerpt({:?}) 里都定位不到",
                hit.title,
                hit.excerpt
            );
        }
    }
}

#[test]
fn pinyin_hits_carry_no_matched_terms() {
    let mut conn = test_conn();
    seed(&mut conn, "知识图谱", 1_000);

    // 全拼、首字母、LIKE 兜底三条拼音路径都要遵守同一条契约：
    // 归一化后的查询串在原文里根本不存在，给不出可定位的片段，只能为空。
    for query in ["zhishitupu", "zstp", "zs"] {
        let hits = search::search(&conn, query, 10).unwrap();
        assert_eq!(hits.len(), 1, "{query} 应命中");
        assert_ne!(hits[0].source, HitSource::Literal);
        assert!(
            hits[0].matched_terms.is_empty(),
            "{query} 的拼音命中不该带高亮词: {:?}",
            hits[0].matched_terms
        );
    }
}

// ----------------------------------------------------------- 更新后的可检索性

#[test]
fn update_makes_new_content_searchable_and_old_content_unfindable() {
    let mut conn = test_conn();
    let id = seed_lines(&mut conn, &["知识图谱", "旧的正文内容"], 1_000);
    assert_eq!(search::search(&conn, "知识图", 10).unwrap().len(), 1);

    notes::update(&mut conn, id, &doc("向量数据库"), &[], 2_000).unwrap();

    assert!(
        search::search(&conn, "知识图", 10).unwrap().is_empty(),
        "旧内容改掉后就不该再被搜到"
    );
    assert!(
        search::search(&conn, "旧的正文", 10).unwrap().is_empty(),
        "旧正文改掉后就不该再被搜到"
    );

    let hits = search::search(&conn, "向量数据", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::Literal);

    // 拼音索引同样要跟着换掉。
    assert!(
        search::search(&conn, "zhishitupu", 10).unwrap().is_empty(),
        "旧内容的拼音索引也该被清掉"
    );
    let hits = search::search(&conn, "xlsjk", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinHead);
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
