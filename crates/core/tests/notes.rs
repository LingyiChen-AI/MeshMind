mod common;

use meshmind_core::CoreError;
use meshmind_core::notes::{self, NewNote};

use common::{TINY_PNG, doc, test_conn};

fn new(text: &str) -> NewNote {
    NewNote {
        body_json: doc(text),
        attachment_ids: vec![],
    }
}

#[test]
fn creates_note_with_derived_title_and_text() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &new("知识图谱构建"), 1_000).unwrap();

    assert_eq!(note.title, "知识图谱构建");
    assert_eq!(note.body_text, "知识图谱构建");
    assert_eq!(note.created_at, 1_000);
    assert!(!note.uuid.is_empty());
}

#[test]
fn creates_note_with_parsed_tags() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &new("读了 #论文 #Rust"), 1_000).unwrap();

    assert_eq!(note.tags, vec!["rust".to_string(), "论文".to_string()]);
}

#[test]
fn writes_both_index_tables() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &new("知识图谱"), 1_000).unwrap();

    let fts: i64 = conn
        .query_row(
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();
    let py: String = conn
        .query_row(
            "SELECT py_full FROM notes_py WHERE rowid = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(fts, 1);
    assert_eq!(py, "zhishitupu");
}

#[test]
fn links_attachments_to_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let file = meshmind_core::attachments::store(&conn, dir.path(), TINY_PNG, "png", 500).unwrap();

    let note = notes::create(
        &mut conn,
        &NewNote {
            body_json: doc("带图的笔记"),
            attachment_ids: vec![file.id],
        },
        1_000,
    )
    .unwrap();

    assert_eq!(note.attachment_ids, vec![file.id]);
}

#[test]
fn rolls_back_entirely_when_attachment_is_missing() {
    let mut conn = test_conn();

    let result = notes::create(
        &mut conn,
        &NewNote {
            body_json: doc("引用了不存在的附件"),
            attachment_ids: vec![999],
        },
        1_000,
    );

    // 裸的 FOREIGN KEY constraint failed 对用户毫无意义，必须是具名错误。
    assert!(
        matches!(result, Err(CoreError::AttachmentNotFound(999))),
        "应返回 AttachmentNotFound(999)，实际: {result:?}"
    );
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0, "事务失败后不应残留笔记行");
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 0, "事务失败后不应残留索引行");
    let py_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_py", [], |r| r.get(0))
        .unwrap();
    assert_eq!(py_rows, 0, "事务失败后不应残留拼音索引行");
    let link_rows: i64 = conn
        .query_row("SELECT count(*) FROM note_attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(link_rows, 0, "事务失败后不应残留附件关联行");
}

/// 更新走的是同一条 link_attachments 路径，错误也必须同样可读，且不能改坏原有笔记。
#[test]
fn update_rejects_missing_attachment_without_touching_the_note() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &new("原始内容"), 1_000).unwrap();

    let result = notes::update(&mut conn, note.id, &doc("改写后的内容"), &[999], 2_000);

    assert!(
        matches!(result, Err(CoreError::AttachmentNotFound(999))),
        "应返回 AttachmentNotFound(999)，实际: {result:?}"
    );
    let reloaded = notes::get(&conn, note.id).unwrap();
    assert_eq!(reloaded.title, "原始内容", "失败的更新不应改动笔记");
    assert_eq!(reloaded.updated_at, 1_000);
}

#[test]
fn rejects_invalid_json() {
    let mut conn = test_conn();

    let result = notes::create(
        &mut conn,
        &NewNote {
            body_json: "not json".into(),
            attachment_ids: vec![],
        },
        1_000,
    );

    assert!(result.is_err());
}

#[test]
fn reads_back_a_created_note() {
    let mut conn = test_conn();
    let created = notes::create(&mut conn, &new("原文"), 1_000).unwrap();

    let loaded = notes::get(&conn, created.id).unwrap();

    assert_eq!(loaded, created);
}

#[test]
fn get_returns_error_for_missing_note() {
    let conn = test_conn();
    assert!(notes::get(&conn, 999).is_err());
}

#[test]
fn lists_notes_newest_first() {
    let mut conn = test_conn();
    notes::create(&mut conn, &new("旧"), 1_000).unwrap();
    notes::create(&mut conn, &new("新"), 2_000).unwrap();

    let list = notes::list(&conn, 10, 0).unwrap();

    assert_eq!(list.len(), 2);
    assert_eq!(list[0].title, "新");
    assert_eq!(list[1].title, "旧");
}

#[test]
fn list_respects_limit_and_offset() {
    let mut conn = test_conn();
    for i in 0..3 {
        notes::create(&mut conn, &new(&format!("第{i}条")), 1_000 + i).unwrap();
    }

    let page = notes::list(&conn, 1, 1).unwrap();

    assert_eq!(page.len(), 1);
    assert_eq!(page[0].title, "第1条");
}

#[test]
fn update_replaces_content_tags_and_index() {
    let mut conn = test_conn();
    let created = notes::create(&mut conn, &new("旧内容 #旧标签"), 1_000).unwrap();

    let updated = notes::update(&mut conn, created.id, &doc("新内容 #新标签"), &[], 2_000).unwrap();

    assert_eq!(updated.title, "新内容 #新标签");
    assert_eq!(updated.tags, vec!["新标签".to_string()]);
    assert_eq!(updated.created_at, 1_000, "创建时间不应被改写");
    assert_eq!(updated.updated_at, 2_000);
    let index_rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            [created.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index_rows, 1, "更新后索引行应恰好一条，不能重复插入");
}

#[test]
fn soft_deleted_note_disappears_from_list_and_index() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &new("待删除"), 1_000).unwrap();

    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    assert!(notes::list(&conn, 10, 0).unwrap().is_empty());
    assert!(notes::get(&conn, note.id).is_err());
    let index_rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index_rows, 0, "删除后索引行必须一并剔除");
}

#[test]
fn deleted_note_is_listed_in_trash() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &new("待删除"), 1_000).unwrap();
    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    let trash = notes::list_deleted(&conn, 10, 0).unwrap();

    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, note.id);
}

#[test]
fn restore_brings_back_note_and_index() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &new("知识图谱"), 1_000).unwrap();
    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    notes::restore(&mut conn, note.id, 3_000).unwrap();

    assert_eq!(notes::list(&conn, 10, 0).unwrap().len(), 1);
    let index_rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index_rows, 1, "恢复后索引行必须重建");
}
