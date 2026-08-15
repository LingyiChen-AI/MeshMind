mod common;

use std::collections::BTreeMap;

use meshmind_core::settings;

use common::test_conn;

#[test]
fn missing_key_reads_as_none() {
    let conn = test_conn();
    assert_eq!(settings::get(&conn, "theme").unwrap(), None);
}

#[test]
fn set_then_get_round_trips() {
    let conn = test_conn();
    settings::set(&conn, "theme", "dark").unwrap();
    assert_eq!(settings::get(&conn, "theme").unwrap(), Some("dark".into()));
}

#[test]
fn set_upserts_instead_of_failing_on_the_primary_key() {
    let conn = test_conn();
    settings::set(&conn, "theme", "dark").unwrap();
    settings::set(&conn, "theme", "light").unwrap();
    assert_eq!(settings::get(&conn, "theme").unwrap(), Some("light".into()));

    let rows: i64 = conn
        .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "重复写同一个 key 不该留下多行");
}

#[test]
fn empty_string_is_a_value_not_an_absence() {
    // 值一律是字符串，空串是一个合法的值，和「没设过」必须区分得开。
    let conn = test_conn();
    settings::set(&conn, "note_dir", "").unwrap();
    assert_eq!(
        settings::get(&conn, "note_dir").unwrap(),
        Some(String::new())
    );
}

#[test]
fn get_all_is_sorted_by_key() {
    let conn = test_conn();
    for (key, value) in [("theme", "dark"), ("autostart", "true"), ("zoom", "1.25")] {
        settings::set(&conn, key, value).unwrap();
    }

    let all = settings::get_all(&conn).unwrap();
    let expected: BTreeMap<String, String> = [
        ("autostart".to_string(), "true".to_string()),
        ("theme".to_string(), "dark".to_string()),
        ("zoom".to_string(), "1.25".to_string()),
    ]
    .into_iter()
    .collect();
    assert_eq!(all, expected);
    // BTreeMap 的迭代顺序是按 key 升序的，输出因此稳定可测。
    assert_eq!(
        all.keys().collect::<Vec<_>>(),
        vec!["autostart", "theme", "zoom"]
    );
}

#[test]
fn get_all_on_a_fresh_database_is_empty() {
    let conn = test_conn();
    assert!(settings::get_all(&conn).unwrap().is_empty());
}

#[test]
fn values_are_opaque_strings_to_the_core() {
    // 内核不解释类型：布尔、数字、JSON 一律原样存取。
    let conn = test_conn();
    for (key, value) in [
        ("autostart", "true"),
        ("window_width", "1280"),
        ("shortcuts", r#"{"save":"mod+s"}"#),
    ] {
        settings::set(&conn, key, value).unwrap();
        assert_eq!(settings::get(&conn, key).unwrap(), Some(value.to_string()));
    }
}
