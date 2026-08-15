mod common;

use meshmind_core::attachments;
use meshmind_core::notes::{self, NewNote};

use common::{TINY_PNG, doc, test_conn};

#[test]
fn stores_file_under_sharded_content_addressed_path() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();

    let path = dir
        .path()
        .join(attachments::relative_path(&stored.sha256, "png"));
    assert!(path.exists(), "附件文件未落盘: {path:?}");
    assert_eq!(
        path.parent().unwrap().file_name().unwrap().to_str().unwrap(),
        &stored.sha256[0..2],
        "未按 hash 前两位分片"
    );
}

#[test]
fn deduplicates_identical_content() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let first = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();
    let second = attachments::store(&conn, dir.path(), TINY_PNG, "png", 2_000).unwrap();

    assert_eq!(first.id, second.id, "相同内容应复用同一条附件记录");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn parses_image_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();

    assert_eq!(stored.width, Some(1));
    assert_eq!(stored.height, Some(1));
}

#[test]
fn stores_non_image_without_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), b"just text", "txt", 1_000).unwrap();

    assert_eq!(stored.width, None);
    assert_eq!(stored.byte_size, 9);
}

#[test]
fn collects_unreferenced_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    let orphan = attachments::store(&conn, dir.path(), b"orphan bytes", "txt", 1_000).unwrap();
    let path = dir
        .path()
        .join(attachments::relative_path(&orphan.sha256, "txt"));

    let removed = attachments::collect_garbage(&conn, dir.path()).unwrap();

    assert_eq!(removed, 1);
    assert!(!path.exists(), "孤儿文件应被删除");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn keeps_attachments_referenced_by_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let kept = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();
    notes::create(
        &mut conn,
        &NewNote {
            body_json: doc("带图"),
            attachment_ids: vec![kept.id],
        },
        1_000,
    )
    .unwrap();

    let removed = attachments::collect_garbage(&conn, dir.path()).unwrap();

    assert_eq!(removed, 0);
    let path = dir
        .path()
        .join(attachments::relative_path(&kept.sha256, "png"));
    assert!(path.exists(), "被引用的附件不能被回收");
}
