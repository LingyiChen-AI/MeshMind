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
        path.parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
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
fn collects_unreferenced_attachments_older_than_the_grace_window() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    let orphan = attachments::store(&conn, dir.path(), b"orphan bytes", "txt", 1_000).unwrap();
    let path = dir
        .path()
        .join(attachments::relative_path(&orphan.sha256, "txt"));

    let now = 1_000 + attachments::GC_GRACE_MS + 1;
    let removed =
        attachments::collect_garbage_with_grace(&conn, dir.path(), now, attachments::GC_GRACE_MS)
            .unwrap();

    assert_eq!(removed, 1);
    assert!(!path.exists(), "孤儿文件应被删除");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

/// 这是本次改动要拦的雷：附件先落盘、笔记后保存，中间那段窗口里附件是零引用的。
/// 宽限期内绝不能回收，否则随后的 link_attachments 会撞外键失败，整条笔记都存不进去。
#[test]
fn keeps_unreferenced_attachments_inside_the_grace_window() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    let fresh = attachments::store(&conn, dir.path(), b"just pasted", "png", 10_000).unwrap();
    let path = dir
        .path()
        .join(attachments::relative_path(&fresh.sha256, "png"));

    // 粘贴后 1 分钟就跑 GC：用户还在打字。
    let now = 10_000 + 60_000;
    let removed =
        attachments::collect_garbage_with_grace(&conn, dir.path(), now, attachments::GC_GRACE_MS)
            .unwrap();

    assert_eq!(removed, 0, "宽限期内的零引用附件不能被回收");
    assert!(path.exists(), "宽限期内的附件文件必须留着");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "宽限期内的附件记录必须留着");
}

/// 边界语义：宽限期是闭区间，`created_at == now - grace` 仍在保护中，
/// 必须严格早于截止点才回收。差一毫秒就丢笔记的代价太大，边界一律从宽。
#[test]
fn treats_the_grace_boundary_as_still_protected() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    let edge = attachments::store(&conn, dir.path(), b"edge bytes", "txt", 5_000).unwrap();
    let path = dir
        .path()
        .join(attachments::relative_path(&edge.sha256, "txt"));
    let grace = 1_000;

    // created_at 恰好等于 now - grace：不回收。
    let removed =
        attachments::collect_garbage_with_grace(&conn, dir.path(), 5_000 + grace, grace).unwrap();
    assert_eq!(removed, 0, "created_at == now - grace 时应视为仍在宽限期内");
    assert!(path.exists());

    // 再晚 1 毫秒就越界：回收。
    let removed =
        attachments::collect_garbage_with_grace(&conn, dir.path(), 5_000 + grace + 1, grace)
            .unwrap();
    assert_eq!(removed, 1, "越过边界 1 毫秒即应回收");
    assert!(!path.exists());
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
    let path = dir
        .path()
        .join(attachments::relative_path(&kept.sha256, "png"));

    // 无论过去多久，被引用的附件都不回收。
    for now in [1_000, 1_000 + attachments::GC_GRACE_MS + 1, i64::MAX / 2] {
        let removed = attachments::collect_garbage_with_grace(
            &conn,
            dir.path(),
            now,
            attachments::GC_GRACE_MS,
        )
        .unwrap();
        assert_eq!(removed, 0, "被引用的附件不能被回收（now = {now}）");
        assert!(path.exists(), "被引用的附件文件不能被删（now = {now}）");
    }
}

/// 宽限期设为 0 等于关掉护栏：留给「确定没有半成品笔记」的场景（比如启动时的一次性清理）。
#[test]
fn zero_grace_collects_everything_unreferenced() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    attachments::store(&conn, dir.path(), b"orphan bytes", "txt", 1_000).unwrap();

    let removed = attachments::collect_garbage_with_grace(&conn, dir.path(), 1_001, 0).unwrap();

    assert_eq!(removed, 1);
}

/// 兼容壳层的旧签名：读系统时钟并套用默认宽限期。
/// 1970 年的时间戳早就过了宽限期，所以这里应当被回收。
#[test]
fn default_entry_point_uses_the_named_grace_constant() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    attachments::store(&conn, dir.path(), b"ancient orphan", "txt", 1_000).unwrap();

    let removed = attachments::collect_garbage(&conn, dir.path()).unwrap();

    assert_eq!(removed, 1);
}

/// 常量得是「够用但别太久」：至少覆盖快捕晾几十秒 / 主窗口写长笔记，
/// 又不至于让孤儿文件堆到天荒地老。
#[test]
fn grace_constant_is_one_hour() {
    assert_eq!(attachments::GC_GRACE_MS, 60 * 60 * 1_000);
}
