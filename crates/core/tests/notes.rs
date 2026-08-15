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

// ------------------------------------------------------------------- 硬删除

/// 播一条带标签和附件的笔记并软删除，返回 (note_id, attachment_id)。
fn seed_deleted_with_relations(
    conn: &mut rusqlite::Connection,
    dir: &std::path::Path,
    bytes: &[u8],
) -> (i64, i64) {
    let file = meshmind_core::attachments::store(conn, dir, bytes, "png", 500).unwrap();
    let note = notes::create(
        conn,
        &NewNote {
            body_json: doc("知识图谱 #论文"),
            attachment_ids: vec![file.id],
        },
        1_000,
    )
    .unwrap();
    notes::soft_delete(conn, note.id, 2_000).unwrap();
    (note.id, file.id)
}

fn count(conn: &rusqlite::Connection, sql: &str, id: i64) -> i64 {
    conn.query_row(sql, [id], |r| r.get(0)).unwrap()
}

#[test]
fn purge_removes_the_note_with_all_of_its_relations_and_index_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let (note_id, attachment_id) = seed_deleted_with_relations(&mut conn, dir.path(), TINY_PNG);

    notes::purge(&mut conn, note_id).unwrap();

    assert_eq!(
        count(&conn, "SELECT count(*) FROM notes WHERE id = ?1", note_id),
        0
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM note_tags WHERE note_id = ?1",
            note_id
        ),
        0,
        "标签关联必须一并清掉"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM note_attachments WHERE note_id = ?1",
            note_id
        ),
        0,
        "附件关联必须一并清掉"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            note_id
        ),
        0
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM notes_py WHERE rowid = ?1",
            note_id
        ),
        0
    );
    // 回收站里也不该再有它。
    assert!(notes::list_deleted(&conn, 10, 0).unwrap().is_empty());

    // 附件本身还在，只是变成零引用了——真正的删文件交给下一轮 GC。
    assert!(
        meshmind_core::attachments::get(&conn, attachment_id)
            .unwrap()
            .is_some(),
        "purge 不负责删附件，只负责让它变成零引用"
    );
}

#[test]
fn purged_attachment_becomes_collectable_by_the_next_gc() {
    // purge 与 GC 的衔接：purge 摘掉最后一条引用，附件在下一轮
    // 过了宽限期的 GC 里才真正落盘删除。
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let (note_id, attachment_id) = seed_deleted_with_relations(&mut conn, dir.path(), TINY_PNG);

    // purge 之前它有引用，GC 碰不得它。
    let collected =
        meshmind_core::attachments::collect_garbage_with_grace(&conn, dir.path(), 10_000_000, 0)
            .unwrap();
    assert_eq!(collected, 0, "还被笔记引用着的附件不该被回收");

    notes::purge(&mut conn, note_id).unwrap();

    let collected =
        meshmind_core::attachments::collect_garbage_with_grace(&conn, dir.path(), 10_000_000, 0)
            .unwrap();
    assert_eq!(collected, 1, "purge 后附件应变成零引用并被回收");
    assert!(
        meshmind_core::attachments::get(&conn, attachment_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn purge_rejects_a_live_note() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &new("还活着"), 1_000).unwrap();

    let err = notes::purge(&mut conn, note.id).unwrap_err();

    assert!(
        matches!(err, CoreError::NoteNotDeleted(id) if id == note.id),
        "硬删一条活着的笔记应当报错: {err:?}"
    );
    // 报错之后笔记必须原封不动。
    assert_eq!(notes::get(&conn, note.id).unwrap().title, "还活着");
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM notes_fts WHERE rowid = ?1",
            note.id
        ),
        1,
        "被拒绝的 purge 不该动索引"
    );
}

#[test]
fn purge_reports_a_missing_note() {
    let mut conn = test_conn();
    let err = notes::purge(&mut conn, 999).unwrap_err();
    assert!(matches!(err, CoreError::NoteNotFound(999)), "{err:?}");
}

#[test]
fn purge_all_deleted_empties_the_trash_and_leaves_live_notes_alone() {
    let mut conn = test_conn();
    let live_a = notes::create(&mut conn, &new("活着的甲"), 1_000).unwrap();
    let trashed_a = notes::create(&mut conn, &new("回收站的甲"), 1_100).unwrap();
    let trashed_b = notes::create(&mut conn, &new("回收站的乙 #论文"), 1_200).unwrap();
    let live_b = notes::create(&mut conn, &new("活着的乙"), 1_300).unwrap();
    notes::soft_delete(&mut conn, trashed_a.id, 2_000).unwrap();
    notes::soft_delete(&mut conn, trashed_b.id, 2_100).unwrap();

    let purged = notes::purge_all_deleted(&mut conn).unwrap();

    assert_eq!(purged, 2, "返回的条数必须是真正删掉的软删笔记数");
    assert!(notes::list_deleted(&conn, 10, 0).unwrap().is_empty());
    for id in [trashed_a.id, trashed_b.id] {
        assert_eq!(
            count(&conn, "SELECT count(*) FROM notes WHERE id = ?1", id),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM note_tags WHERE note_id = ?1",
                id
            ),
            0
        );
        assert_eq!(
            count(&conn, "SELECT count(*) FROM notes_fts WHERE rowid = ?1", id),
            0
        );
    }

    // 活着的笔记连同索引一根毫毛都不能少。
    let live = notes::list(&conn, 10, 0).unwrap();
    assert_eq!(
        live.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![live_b.id, live_a.id]
    );
    for id in [live_a.id, live_b.id] {
        assert_eq!(
            count(&conn, "SELECT count(*) FROM notes_fts WHERE rowid = ?1", id),
            1,
            "活着的笔记索引不该被清空回收站波及"
        );
    }
}

#[test]
fn purge_all_deleted_on_an_empty_trash_is_a_no_op() {
    let mut conn = test_conn();
    notes::create(&mut conn, &new("活着"), 1_000).unwrap();

    assert_eq!(notes::purge_all_deleted(&mut conn).unwrap(), 0);
    assert_eq!(notes::list(&conn, 10, 0).unwrap().len(), 1);
}

// --------------------------------------------------------------- 按标签查询

/// 播一条笔记并返回 id，正文即入参（标签写在正文里由 parse_tags 解析）。
fn seed(conn: &mut rusqlite::Connection, text: &str, now: i64) -> i64 {
    notes::create(conn, &new(text), now).unwrap().id
}

#[test]
fn list_by_tag_returns_only_notes_carrying_that_tag() {
    let mut conn = test_conn();
    let a = seed(&mut conn, "甲 #论文", 1_000);
    seed(&mut conn, "乙 #随笔", 1_100);
    let c = seed(&mut conn, "丙 #论文 #随笔", 1_200);

    let hits = notes::list_by_tag(&conn, "论文", 10, 0).unwrap();

    // updated_at 倒序。
    assert_eq!(hits.iter().map(|n| n.id).collect::<Vec<_>>(), vec![c, a]);
    // 每条都带上自己的全部标签，和 list 的语义一致。
    assert_eq!(hits[0].tags, vec!["论文".to_string(), "随笔".to_string()]);
    assert_eq!(hits[1].tags, vec!["论文".to_string()]);
}

#[test]
fn list_by_tag_excludes_soft_deleted_notes() {
    let mut conn = test_conn();
    let live = seed(&mut conn, "活着 #论文", 1_000);
    let trashed = seed(&mut conn, "回收站 #论文", 1_100);
    notes::soft_delete(&mut conn, trashed, 2_000).unwrap();

    let hits = notes::list_by_tag(&conn, "论文", 10, 0).unwrap();

    assert_eq!(hits.iter().map(|n| n.id).collect::<Vec<_>>(), vec![live]);
}

#[test]
fn list_by_tag_respects_limit_and_offset() {
    let mut conn = test_conn();
    let ids: Vec<i64> = (0..5)
        .map(|i| seed(&mut conn, &format!("第{i}条 #论文"), 1_000 + i))
        .collect();

    let page_one = notes::list_by_tag(&conn, "论文", 2, 0).unwrap();
    let page_two = notes::list_by_tag(&conn, "论文", 2, 2).unwrap();
    let page_three = notes::list_by_tag(&conn, "论文", 2, 4).unwrap();

    assert_eq!(
        page_one.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![ids[4], ids[3]]
    );
    assert_eq!(
        page_two.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![ids[2], ids[1]]
    );
    assert_eq!(
        page_three.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![ids[0]]
    );
}

#[test]
fn list_by_tag_returns_empty_for_an_unknown_tag() {
    let mut conn = test_conn();
    seed(&mut conn, "甲 #论文", 1_000);
    assert!(
        notes::list_by_tag(&conn, "不存在的标签", 10, 0)
            .unwrap()
            .is_empty()
    );
    // 标签匹配是精确相等，不是前缀也不是子串。
    assert!(notes::list_by_tag(&conn, "论", 10, 0).unwrap().is_empty());
    assert!(
        notes::list_by_tag(&conn, "论文集", 10, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn list_by_tag_matches_the_lowercased_form_stored_in_the_database() {
    // 标签入库时统一小写，调用方传进来的也该是小写——这是文档注释写明的前提。
    let mut conn = test_conn();
    let id = seed(&mut conn, "甲 #Rust", 1_000);
    assert_eq!(
        notes::list_by_tag(&conn, "rust", 10, 0)
            .unwrap()
            .iter()
            .map(|n| n.id)
            .collect::<Vec<_>>(),
        vec![id]
    );
    assert!(notes::list_by_tag(&conn, "Rust", 10, 0).unwrap().is_empty());
}

#[test]
fn all_with_counts_sorts_by_count_then_name() {
    use meshmind_core::notes::tags::TagCount;

    let mut conn = test_conn();
    seed(&mut conn, "甲 #论文 #rust #zig", 1_000);
    seed(&mut conn, "乙 #论文 #rust", 1_100);
    seed(&mut conn, "丙 #论文", 1_200);

    let counts = notes::tags::all_with_counts(&conn).unwrap();

    assert_eq!(
        counts,
        vec![
            TagCount {
                name: "论文".into(),
                count: 3
            },
            TagCount {
                name: "rust".into(),
                count: 2
            },
            // 同为 1 时按名称升序：zig 是这一档里唯一一个。
            TagCount {
                name: "zig".into(),
                count: 1
            },
        ]
    );
}

#[test]
fn all_with_counts_breaks_ties_by_name_ascending() {
    let mut conn = test_conn();
    seed(&mut conn, "甲 #c #b #a", 1_000);

    let counts = notes::tags::all_with_counts(&conn).unwrap();

    assert_eq!(
        counts.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        vec!["a", "b", "c"],
        "同数量必须按名称升序，输出才稳定"
    );
    assert!(counts.iter().all(|t| t.count == 1));
}

#[test]
fn all_with_counts_ignores_soft_deleted_notes() {
    let mut conn = test_conn();
    seed(&mut conn, "甲 #论文", 1_000);
    let trashed = seed(&mut conn, "乙 #论文 #随笔", 1_100);
    notes::soft_delete(&mut conn, trashed, 2_000).unwrap();

    let counts = notes::tags::all_with_counts(&conn).unwrap();

    assert_eq!(counts.len(), 1, "只剩活笔记上的标签: {counts:?}");
    assert_eq!(counts[0].name, "论文");
    assert_eq!(counts[0].count, 1, "软删笔记不该计入");
}

#[test]
fn all_with_counts_is_empty_when_nothing_is_tagged() {
    let mut conn = test_conn();
    seed(&mut conn, "没有标签的笔记", 1_000);
    assert!(notes::tags::all_with_counts(&conn).unwrap().is_empty());
}
