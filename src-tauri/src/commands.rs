//! IPC 命令层：把 meshmind-core 的能力暴露给前端。

use meshmind_core::attachments::{self, Attachment};
use meshmind_core::notes::{self, NewNote, Note, NoteSummary};
use meshmind_core::search::{self, SearchHit};
use meshmind_core::{now_ms, CoreError};
use serde::{Serialize, Serializer};
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;
use crate::window;

/// 传给前端的错误。
///
/// 前端只需要一句能直接显示给用户的中文提示，不需要 Rust 那套错误结构
/// （变体名、source 链条对 TS 侧毫无意义，只会逼前端写 tagged union 解析）。
/// 因此手写 `Serialize`，序列化结果就是一个 JSON 字符串。
#[derive(Debug)]
pub struct CommandError(String);

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

impl From<CoreError> for CommandError {
    fn from(err: CoreError) -> Self {
        Self(err.to_string())
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 命令统一的返回类型。
type CmdResult<T> = Result<T, CommandError>;

/// 取数据库连接。
///
/// 锁中毒意味着某个线程持有这把锁时 panic 了，数据库很可能停在一个写了一半的
/// 事务或不一致的中间状态上；此时继续复用这个连接是在拿用户数据赌运气。
/// 直接 panic 让进程带着明确的错误信息倒下，比静默地继续跑安全得多。
macro_rules! conn {
    ($state:expr) => {
        $state.conn.lock().expect("数据库连接锁已中毒")
    };
}

#[tauri::command]
pub fn create_note(
    state: State<'_, AppState>,
    body_json: String,
    attachment_ids: Vec<i64>,
) -> CmdResult<Note> {
    let mut conn = conn!(state);
    let new = NewNote {
        body_json,
        attachment_ids,
    };
    Ok(notes::create(&mut conn, &new, now_ms())?)
}

#[tauri::command]
pub fn update_note(
    state: State<'_, AppState>,
    id: i64,
    body_json: String,
    attachment_ids: Vec<i64>,
) -> CmdResult<Note> {
    let mut conn = conn!(state);
    Ok(notes::update(
        &mut conn,
        id,
        &body_json,
        &attachment_ids,
        now_ms(),
    )?)
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: i64) -> CmdResult<Note> {
    let conn = conn!(state);
    Ok(notes::get(&conn, id)?)
}

#[tauri::command]
pub fn list_notes(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<NoteSummary>> {
    let conn = conn!(state);
    Ok(notes::list(&conn, limit, offset)?)
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = conn!(state);
    Ok(notes::soft_delete(&mut conn, id, now_ms())?)
}

#[tauri::command]
pub fn restore_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = conn!(state);
    Ok(notes::restore(&mut conn, id, now_ms())?)
}

#[tauri::command]
pub fn list_deleted_notes(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<NoteSummary>> {
    let conn = conn!(state);
    Ok(notes::list_deleted(&conn, limit, offset)?)
}

#[tauri::command]
pub fn search_notes(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> CmdResult<Vec<SearchHit>> {
    let conn = conn!(state);
    Ok(search::search(&conn, &query, limit)?)
}

#[tauri::command]
pub fn rebuild_index(state: State<'_, AppState>) -> CmdResult<usize> {
    let mut conn = conn!(state);
    Ok(notes::rebuild_index(&mut conn)?)
}

/// 扩展名的长度上限。真实扩展名都在 5 个字符以内（jpeg / webp / heic），
/// 16 已经宽到不会误伤任何合法输入，同时把「超长字符串塞进路径」这类玩法挡在外面。
const MAX_EXT_LEN: usize = 16;

/// 校验附件扩展名。
///
/// `ext` 会被 `attachments::relative_path` 直接拼进文件名再 `join` 到附件根目录下，
/// 所以它是一个能影响写盘位置的参数：`".."`、`"/"`、`"\\"` 之类的字符一旦放过去，
/// 就等于把任意路径写的能力交给了调用方。命令层是这个参数唯一的入口，把关放在这里。
/// 只放行 ASCII 字母数字：合法扩展名本来就在这个集合内，白名单比黑名单少一类漏网之鱼。
fn validate_ext(ext: &str) -> CmdResult<()> {
    if ext.is_empty() {
        return Err(CommandError("附件扩展名 ext 不能为空".into()));
    }
    if ext.len() > MAX_EXT_LEN {
        return Err(CommandError(format!(
            "附件扩展名 ext 过长（{} 字节，上限 {MAX_EXT_LEN}）",
            ext.len()
        )));
    }
    if !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(CommandError(format!(
            "附件扩展名 ext 只能包含 ASCII 字母和数字，实际收到: {ext:?}"
        )));
    }
    Ok(())
}

#[tauri::command]
pub fn store_attachment(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    ext: String,
) -> CmdResult<Attachment> {
    validate_ext(&ext)?;
    let conn = conn!(state);
    Ok(attachments::store(
        &conn,
        &state.attachments_root,
        &bytes,
        &ext,
        now_ms(),
    )?)
}

/// 读附件原始字节。前端拿到后自行建 blob URL 显示图片。
#[tauri::command]
pub fn read_attachment(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<u8>> {
    let conn = conn!(state);
    let attachment = attachments::get(&conn, id)?.ok_or(CoreError::AttachmentNotFound(id))?;
    let path = state.attachments_root.join(attachments::relative_path(
        &attachment.sha256,
        &attachment.ext,
    ));
    Ok(std::fs::read(path).map_err(CoreError::from)?)
}

#[tauri::command]
pub fn collect_garbage(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = conn!(state);
    Ok(attachments::collect_garbage(
        &conn,
        &state.attachments_root,
    )?)
}

/// 让快捕窗口收起自己。
///
/// 前端本可以直接调 `getCurrentWindow().hide()`，但那条路要靠 `core:window:allow-hide`
/// 这个 ACL 权限，而 `core:window:default` 是纯只读集合、并不包含它——权限一缺，
/// hide 就被 reject，窗口留在屏幕上不动。走命令层则只依赖 Rust 侧的窗口句柄：
/// 前端与外壳之间仍然只有命令这一个契约，将来 Tauri 调整默认权限集也炸不到这里。
#[tauri::command]
pub fn hide_capture_window<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    Ok(window::hide(&app, window::CAPTURE)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_extensions() {
        for ext in [
            "png", "jpg", "jpeg", "webp", "gif", "bin", "mp4", "7z", "PNG",
        ] {
            assert!(validate_ext(ext).is_ok(), "{ext} 应当被放行");
        }
    }

    #[test]
    fn rejects_empty_ext() {
        let err = validate_ext("").expect_err("空扩展名应当被拒绝");
        assert!(err.to_string().contains("ext"), "错误里应点名参数: {err}");
    }

    #[test]
    fn rejects_overlong_ext() {
        let err = validate_ext(&"a".repeat(MAX_EXT_LEN + 1)).expect_err("超长扩展名应当被拒绝");
        assert!(err.to_string().contains("过长"), "实际: {err}");
        assert!(
            validate_ext(&"a".repeat(MAX_EXT_LEN)).is_ok(),
            "刚好到上限应当放行"
        );
    }

    /// 这条是这个校验存在的理由：`ext` 会被拼进写盘路径。
    #[test]
    fn rejects_path_traversal_ext() {
        for ext in [
            "../../../../evil",
            "..",
            "png/../../evil",
            "png/evil",
            "png\\evil",
            "/etc/passwd",
            "pn g",
            "png\0",
            "png.",
            "png-1",
            "图片",
        ] {
            let err = validate_ext(ext)
                .expect_err(&format!("{ext:?} 会被拼进写盘路径，应当被拒绝"))
                .to_string();
            assert!(err.contains("ext"), "错误里应点名参数，实际: {err}");
        }
    }

    #[test]
    fn serializes_core_error_as_message_string() {
        let err: CommandError = meshmind_core::CoreError::NoteNotFound(7).into();
        assert_eq!(serde_json::to_string(&err).unwrap(), "\"笔记不存在: 7\"");
    }

    /// 跑一次真实的 IPC 往返，钉死前端最关心的两条约定：
    /// 入参用 camelCase，出参是 snake_case。这两件事靠读文档容易记反，
    /// 用 mock runtime 实测一遍，以后谁改坏了测试会红。
    mod ipc {
        use crate::state::AppState;
        use tauri::ipc::CallbackFn;
        use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        use tauri::Manager;

        fn invoke(
            webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
            cmd: &str,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, serde_json::Value> {
            let res = tauri::test::get_ipc_response(
                webview,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: body.into(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            );
            res.map(|b| b.deserialize::<serde_json::Value>().unwrap())
        }

        #[test]
        fn accepts_camel_case_args_and_returns_snake_case_fields() {
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::initialize(dir.path()).unwrap();
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![
                    super::super::create_note,
                    super::super::get_note,
                    super::super::search_notes,
                ])
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            let body = serde_json::json!({
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": "知识图谱" }]
                }]
            })
            .to_string();

            // 入参必须是 camelCase：Rust 侧的 body_json / attachment_ids
            // 在 JS 侧对应 bodyJson / attachmentIds。
            let note = invoke(
                &webview,
                "create_note",
                serde_json::json!({ "bodyJson": body, "attachmentIds": [] }),
            )
            .expect("create_note 应当成功");

            // 出参保持 snake_case：core 的结构体没有 rename_all，字段名原样透出。
            assert!(note.get("body_json").is_some(), "返回字段应为 snake_case");
            assert!(note.get("created_at").is_some(), "返回字段应为 snake_case");
            assert!(
                note.get("bodyJson").is_none(),
                "返回字段不应被转成 camelCase"
            );
            assert_eq!(note["title"], "知识图谱");

            // 同一个参数换成 snake_case 就会解析失败，反证转换确实发生了。
            let err = invoke(
                &webview,
                "create_note",
                serde_json::json!({ "body_json": body, "attachment_ids": [] }),
            )
            .expect_err("snake_case 入参应当被拒绝");
            assert!(
                err.as_str().unwrap_or_default().contains("bodyJson"),
                "错误里应指出缺失的 camelCase 参数，实际: {err}"
            );

            // 单字段参数（id / query）没有下划线，两种写法一致。
            let id = note["id"].as_i64().unwrap();
            let fetched = invoke(&webview, "get_note", serde_json::json!({ "id": id })).unwrap();
            assert_eq!(fetched["id"], id);

            let hits = invoke(
                &webview,
                "search_notes",
                serde_json::json!({ "query": "知识", "limit": 10 }),
            )
            .unwrap();
            assert_eq!(hits[0]["note_id"], id, "SearchHit 字段同样是 snake_case");
        }

        /// 快捕窗口没建起来时，命令必须报错而不是静默成功：前端拿到 ok 就会
        /// 认为窗口已经收起，而它其实还浮在最上层——正是这次要修的症状。
        #[test]
        fn hide_capture_window_reports_missing_window() {
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![super::super::hide_capture_window])
                .build(mock_context(noop_assets()))
                .unwrap();
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            let err = invoke(&webview, "hide_capture_window", serde_json::json!({}))
                .expect_err("没有 capture 窗口时应当报错");
            let message = err.as_str().unwrap_or_default();
            assert!(message.contains("capture"), "错误应点名窗口，实际: {err}");
        }

        #[test]
        fn hide_capture_window_hides_existing_window() {
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![super::super::hide_capture_window])
                .build(mock_context(noop_assets()))
                .unwrap();
            let capture =
                tauri::WebviewWindowBuilder::new(&app, crate::window::CAPTURE, Default::default())
                    .build()
                    .unwrap();

            invoke(&capture, "hide_capture_window", serde_json::json!({}))
                .expect("快捕窗口存在时应当收起成功");
        }

        #[test]
        fn reports_core_errors_as_plain_strings() {
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::initialize(dir.path()).unwrap();
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![super::super::get_note])
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            let err = invoke(&webview, "get_note", serde_json::json!({ "id": 999 }))
                .expect_err("不存在的笔记应当报错");
            assert_eq!(err, serde_json::json!("笔记不存在: 999"));
        }
    }
}
