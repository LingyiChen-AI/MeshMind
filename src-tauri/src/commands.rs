//! IPC 命令层：把 meshmind-core 的能力暴露给前端。

use std::collections::BTreeMap;

use meshmind_core::attachments::{self, Attachment};
use meshmind_core::notes::{self, NewNote, Note, NoteSummary};
use meshmind_core::search::{self, SearchHit};
use meshmind_core::{now_ms, CoreError};
use serde::{Serialize, Serializer};
use tauri::ipc::Response;
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;
use crate::{quit, settings, shortcut, window};

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

/// 按标签列出笔记。
///
/// 筛选必须在这一层做，不能让前端在「已加载的那一页」上过滤——那样「标签」实际
/// 会变成「最近 50 条里出现过的标签」，更早的笔记带同一个标签也筛不出来，
/// 而界面上完全看不出区别。
///
/// `tag` 约定是小写：标签入库时由 `tags::parse_tags` 统一转小写，
/// 前端的标签来源（`list_all_tags` 或笔记自带的 `tags`）给出的也都是小写。
#[tauri::command]
pub fn list_notes_by_tag(
    state: State<'_, AppState>,
    tag: String,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<NoteSummary>> {
    let conn = conn!(state);
    Ok(notes::list_by_tag(&conn, &tag, limit, offset)?)
}

/// 全库标签与计数（只统计未软删的笔记）。
///
/// 是**全库**统计而不是「已加载那一页里出现过的标签」，
/// 否则 chip 上的计数会比真实值小，用户据此判断「这个标签下只有几条」就是错的。
#[tauri::command]
pub fn list_all_tags(state: State<'_, AppState>) -> CmdResult<Vec<notes::tags::TagCount>> {
    let conn = conn!(state);
    Ok(notes::tags::all_with_counts(&conn)?)
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

/// 彻底删除一条**已软删除**的笔记，不可撤销。笔记不在回收站里会报错
/// （`NoteNotDeleted`）——这是刻意的：绕过回收站直接抹掉一条活着的笔记，
/// 用户没有任何撤销余地。
///
/// 附件不会立刻消失：解除引用后要等下一轮 `collect_garbage`（有 1 小时宽限期）
/// 才回收。前端必须把这句话告诉用户，否则他会以为删除没生效、转头去手删文件。
#[tauri::command]
pub fn purge_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = conn!(state);
    Ok(notes::purge(&mut conn, id)?)
}

/// 清空回收站，返回彻底删除的条数。不可撤销。
///
/// 整批在同一个事务里完成，不留下「笔记删了索引还在」的中间态。
/// 活着的笔记一根毫毛都不碰。
#[tauri::command]
pub fn purge_all_deleted(state: State<'_, AppState>) -> CmdResult<usize> {
    let mut conn = conn!(state);
    Ok(notes::purge_all_deleted(&mut conn)?)
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

/// 读附件原始字节。前端拿到的是 `ArrayBuffer`，自行建 blob URL 显示图片。
///
/// 返回 `tauri::ipc::Response` 而不是 `Vec<u8>`：`Vec<u8>` 会被 serde 序列化成 JSON
/// 数字数组，一张 2MB 的截图变成约 7MB 的文本，还要在 JS 侧逐个元素解析回数组——
/// 粘贴大图时那阵卡顿就是这么来的。`Response::new` 走 IPC 的 raw 通道，字节原样过去，
/// 前端拿到的直接是 `ArrayBuffer`，两边都不再有序列化开销。
///
/// **这是一处前端契约变更**：`invoke("read_attachment", { id })` 的返回值
/// 从 `number[]` 变成 `ArrayBuffer`，前端要用 `new Uint8Array(buf)` / `new Blob([buf])` 接。
#[tauri::command]
pub fn read_attachment(state: State<'_, AppState>, id: i64) -> CmdResult<Response> {
    let conn = conn!(state);
    let attachment = attachments::get(&conn, id)?.ok_or(CoreError::AttachmentNotFound(id))?;
    let path = state.attachments_root.join(attachments::relative_path(
        &attachment.sha256,
        &attachment.ext,
    ));
    let bytes = std::fs::read(path).map_err(CoreError::from)?;
    Ok(Response::new(bytes))
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

/// 前端已经把待保存内容落盘，可以退出了。
///
/// 这是 `app-quit-requested` 事件的回执。前端**必须**在保存完成后（成功或失败都算）
/// 调一次：不调也退得掉（有 2 秒兜底），但那 2 秒里用户对着一个点了没反应的菜单项。
#[tauri::command]
pub fn confirm_quit<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    quit::confirm_quit(&app);
    Ok(())
}

/// 读全部设置项。值一律是字符串，语义由前端解释。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<BTreeMap<String, String>> {
    let conn = conn!(state);
    Ok(meshmind_core::settings::get_all(&conn)?)
}

/// 写一个设置项。
///
/// key 必须在 [`settings::ALLOWED_KEYS`] 里；值不校验（解释权在前端）。
/// 唯一的例外是热键：它有专门的 [`set_capture_hotkey`]，因为改热键不只是写一行库，
/// 还要真的把键注册上去——只走这里的话库里写了新键、系统上生效的还是旧键。
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    settings::ensure_allowed(&key)?;
    let conn = conn!(state);
    Ok(meshmind_core::settings::set(&conn, &key, &value)?)
}

/// 运行时更换快捕热键，成功后写进设置。
///
/// `accelerator` 的语法见 [`shortcut::ACCELERATOR_SYNTAX`]，形如 `"CommandOrControl+Shift+K"`。
///
/// 注册和落库任一步失败都回滚到原热键：中间态（新键没注册上、旧键也注销了）意味着
/// 快捕功能在用户不知情的情况下彻底失灵，比「改键没成功」严重得多。
#[tauri::command]
pub fn set_capture_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    accelerator: String,
) -> CmdResult<()> {
    let previous = shortcut::current(&app);
    shortcut::rebind(&app, &accelerator)?;

    let conn = conn!(state);
    let stored = accelerator.trim();
    if let Err(err) = meshmind_core::settings::set(&conn, settings::KEY_CAPTURE_HOTKEY, stored) {
        // 先放锁再回滚：回滚要经由主线程注册热键，而主线程有可能正等着别的东西，
        // 攥着数据库锁进这段等待是给死锁留口子。
        drop(conn);
        shortcut::rollback(&app, previous);
        return Err(CommandError(format!(
            "热键「{stored}」已生效但写入设置失败（{err}），已回滚到原热键。"
        )));
    }
    Ok(())
}

/// 隐藏 / 显示 Dock 图标，并把选择写进设置。仅 macOS 有实际效果。
///
/// **副作用（前端务必在 UI 上告知用户）**：切成 `Accessory` 后 Dock 上不再有 MeshMind
/// 的图标，随之消失的还有「点 Dock 图标把主窗口叫回来」这条路径——macOS 的 Reopen
/// 事件由点击 Dock 图标触发，图标没了，`window::on_run_event` 里那段唤起逻辑就再也
/// 不会被调用。此后能唤回主窗口的入口只剩托盘菜单和快捕热键。在热键注册失败的机器上
/// （托盘 tooltip 会带 ⚠），入口就只剩托盘一个了，打开这个开关前更该提醒一句。
///
/// 非 macOS 平台上只落库不做任何事：这个键是给 macOS 用的，但设置表是跨平台同一张，
/// 静默存下来比报错好——用户在 Windows 上不会看到这个开关，也就不会误触。
#[tauri::command]
pub fn set_hide_dock_icon<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    hide: bool,
) -> CmdResult<()> {
    window::set_dock_icon_hidden(&app, hide)?;

    let conn = conn!(state);
    if let Err(err) = meshmind_core::settings::set(
        &conn,
        settings::KEY_HIDE_DOCK_ICON,
        settings::write_bool(hide),
    ) {
        drop(conn);
        // 不回滚的话，这次会话里图标已经藏了，重启后又冒出来——用户会以为开关坏了。
        let _ = window::set_dock_icon_hidden(&app, !hide);
        return Err(CommandError(format!(
            "Dock 图标显示状态已切换但写入设置失败（{err}），已恢复原状。"
        )));
    }
    Ok(())
}

/// 开 / 关开机自启，并把选择写进设置。
///
/// 真正的落点在系统里，不在这张表里：macOS 是 `~/Library/LaunchAgents/MeshMind.plist`，
/// Windows 是注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `MeshMind` 项。
/// 库里存的那份只是给设置页回显用的镜像——用户完全可能绕过应用直接去删注册表项或
/// plist，那之后两者就对不上了。所以**先动系统、成功了再写库**，顺序反过来的话
/// 一次失败的 enable 会留下一个说「已开启」的设置项。
#[tauri::command]
pub fn set_autostart<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    enabled: bool,
) -> CmdResult<()> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let apply = |on: bool| {
        if on {
            manager.enable()
        } else {
            manager.disable()
        }
    };
    let verb = if enabled { "开启" } else { "关闭" };
    apply(enabled).map_err(|err| CommandError(format!("{verb}开机自启失败: {err}")))?;

    let conn = conn!(state);
    if let Err(err) = meshmind_core::settings::set(
        &conn,
        settings::KEY_AUTOSTART,
        settings::write_bool(enabled),
    ) {
        drop(conn);
        let _ = apply(!enabled);
        return Err(CommandError(format!(
            "开机自启已{verb}但写入设置失败（{err}），已恢复原状。"
        )));
    }
    Ok(())
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
            invoke_raw(webview, cmd, body).map(|b| b.deserialize::<serde_json::Value>().unwrap())
        }

        /// 不做反序列化的版本：用来验证响应走的是 JSON 还是 raw 通道。
        fn invoke_raw(
            webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
            cmd: &str,
            body: serde_json::Value,
        ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
            tauri::test::get_ipc_response(
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
            )
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

        /// `read_attachment` 的返回必须走 raw 通道。
        ///
        /// 这条测试盯的是性能契约而不是功能：改回 `Vec<u8>` 功能照样是对的，
        /// 只是每张图都要多付一次「字节 → JSON 数字数组 → 字节」的来回，
        /// 2MB 的截图会膨胀成约 7MB 文本。功能测试抓不到这种退化，只能这样钉住。
        #[test]
        fn read_attachment_answers_with_raw_bytes() {
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::initialize(dir.path()).unwrap();
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![
                    super::super::store_attachment,
                    super::super::read_attachment,
                ])
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            // 挑一串必然不是合法 UTF-8 的字节：raw 通道要能原样送过去。
            let bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d];
            let stored = invoke(
                &webview,
                "store_attachment",
                serde_json::json!({ "bytes": bytes, "ext": "png" }),
            )
            .expect("store_attachment 应当成功");
            let id = stored["id"].as_i64().unwrap();

            let body = invoke_raw(&webview, "read_attachment", serde_json::json!({ "id": id }))
                .expect("read_attachment 应当成功");
            match body {
                tauri::ipc::InvokeResponseBody::Raw(actual) => assert_eq!(actual, bytes),
                tauri::ipc::InvokeResponseBody::Json(json) => {
                    panic!("附件字节不该走 JSON 通道，实际: {json}")
                }
            }
        }

        /// 设置项的白名单在 IPC 这一层就要生效：这是设置表唯一的入口。
        #[test]
        fn settings_round_trip_and_reject_unknown_keys() {
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::initialize(dir.path()).unwrap();
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![
                    super::super::get_settings,
                    super::super::set_setting,
                ])
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            assert_eq!(
                invoke(&webview, "get_settings", serde_json::json!({})).unwrap(),
                serde_json::json!({}),
                "全新的库里不该有任何设置项"
            );

            invoke(
                &webview,
                "set_setting",
                serde_json::json!({ "key": crate::settings::KEY_AUTOSTART, "value": "true" }),
            )
            .expect("白名单内的 key 应当写入成功");

            assert_eq!(
                invoke(&webview, "get_settings", serde_json::json!({})).unwrap()
                    [crate::settings::KEY_AUTOSTART],
                "true"
            );

            let err = invoke(
                &webview,
                "set_setting",
                serde_json::json!({ "key": "hotkey.captrue", "value": "Alt+Space" }),
            )
            .expect_err("拼错的 key 不该落进设置表");
            let message = err.as_str().unwrap_or_default();
            assert!(
                message.contains("hotkey.captrue"),
                "错误里应点名这个 key，实际: {err}"
            );

            // 被拒的那次不能留下任何痕迹。
            let all = invoke(&webview, "get_settings", serde_json::json!({})).unwrap();
            assert!(
                all.get("hotkey.captrue").is_none(),
                "被拒的 key 不该出现在设置表里: {all}"
            );
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
