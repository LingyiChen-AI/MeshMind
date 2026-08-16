//! IPC 命令层：把 meshmind-core 的能力暴露给前端。

use std::collections::BTreeMap;

use meshmind_core::ai::chat::{self, ChatMessage, Conversation};
use meshmind_core::ai::index;
use meshmind_core::ai::provider::{self, Message};
use meshmind_core::ai::retrieve::Retrieved;
use meshmind_core::attachments::{self, Attachment};
use meshmind_core::notes::{self, NewNote, Note, NoteSummary};
use meshmind_core::search::{self, SearchHit};
use meshmind_core::{now_ms, CoreError};
use serde::{Serialize, Serializer};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Runtime, State};

use crate::ai::ask::{self, AskEvent};
use crate::ai::{config, http, worker};
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

/// 把设置项里的密钥换成一个「设没设过」的布尔。
///
/// 抽成自由函数是为了能直接单测——`get_settings` 本身要 `State`，
/// 而这里真正想钉住的是「密钥不出去」这条规则本身。
pub(crate) fn redact_settings(mut map: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let has_key = map
        .remove(settings::KEY_AI_API_KEY)
        .is_some_and(|v| !v.trim().is_empty());
    map.insert(
        settings::KEY_AI_API_KEY_SET.into(),
        settings::write_bool(has_key).into(),
    );
    map
}

/// 读全部设置项。值一律是字符串，语义由前端解释。
///
/// **密钥不在返回值里**：`ai.api_key` 被剔除、换成合成的 `ai.api_key_set`。
/// 密钥只有一条单向的写入路径（`set_setting`），永远不经 IPC 回到 webview，
/// 也就不会出现在前端日志、错误上报或用户截图里。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<BTreeMap<String, String>> {
    let conn = conn!(state);
    Ok(redact_settings(meshmind_core::settings::get_all(&conn)?))
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

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
//
// 下面这些结构体是 **IPC 的形状**，不属于 core：它们只为设置面板与问答界面
// 而存在，core 里没有任何东西需要它们。

/// 设置面板顶部那块状态。
#[derive(Serialize)]
pub struct AiStatus {
    pub enabled: bool,
    pub configured: bool,
    /// 配置不完整时缺的那一项的中文名，完整时为 None。
    pub missing_field: Option<&'static str>,
    pub pending_notes: i64,
    pub indexed_chunks: i64,
    pub memory_bytes: usize,
    /// 内存索引里维度和当前模型对不上、因而被跳过的向量数。
    /// 非 0 说明换过 embedding 模型却没重建索引。
    pub dim_mismatches: usize,
    pub last_error: Option<String>,
}

/// `ai_preview_index` 与 `ai_enable` 的共用回执：还有多少篇笔记等着建索引。
///
/// 两个命令回同一个形状是有意的——前端在确认框里显示的数字，和确认之后
/// 真正开跑的那批笔记，说的必须是同一件事。
#[derive(Serialize)]
pub struct EnableReport {
    pub pending_notes: i64,
}

/// 连通性自检的结果。两条链路分开报：embedding 通了而对话没通
/// （模型名写错、账号没开对话权限）是很常见的一种半通状态。
#[derive(Serialize)]
pub struct ConnectionReport {
    pub embed_ok: bool,
    /// embedding 的维度。换模型前后对比它就知道索引要不要重建。
    pub embed_dim: Option<usize>,
    pub chat_ok: bool,
    /// 已脱敏。
    pub error: Option<String>,
}

/// 语义检索的结果按笔记归并后的形状。同一篇笔记可能命中多个块，
/// 列表里只出现一次，摘要取分数最高的那一块。
#[derive(Serialize)]
pub struct SemanticHit {
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    pub score: f64,
}

/// 读配置：AI 没开或没配全就返回 None。
///
/// 给「静默降级」的调用方用（搜索框），它们要的是「拿不到就算了」而不是错误。
fn usable_config(state: &State<'_, AppState>) -> Option<provider::AiConfig> {
    let conn = conn!(state);
    if !config::is_enabled(&conn) {
        return None;
    }
    let cfg = config::load(&conn);
    config::missing(&cfg).is_none().then_some(cfg)
}

#[tauri::command]
pub fn ai_status(state: State<'_, AppState>) -> CmdResult<AiStatus> {
    let (enabled, cfg, pending_notes, indexed_chunks, last_error) = {
        let conn = conn!(state);
        let cfg = config::load(&conn);
        (
            config::is_enabled(&conn),
            cfg.clone(),
            index::pending_count(&conn)?,
            index::indexed_chunk_count(&conn, &cfg.embed_model)?,
            index::last_error(&conn)?,
        )
    };

    // 内存索引是另一把锁，等数据库锁放掉之后再取：两把锁没有必要同时持有，
    // 叠在一起只会多出一处加锁顺序要操心的地方。
    let (memory_bytes, dim_mismatches) = {
        let slot = state.ai.index.lock().expect("向量索引锁已中毒");
        slot.as_ref()
            .map_or((0, 0), |i| (i.memory_bytes(), i.dim_mismatches()))
    };

    let missing_field = config::missing(&cfg);
    Ok(AiStatus {
        enabled,
        configured: missing_field.is_none(),
        missing_field,
        pending_notes,
        indexed_chunks,
        memory_bytes,
        dim_mismatches,
        last_error,
    })
}

/// 「如果现在启用 AI，会有多少篇笔记要建索引」。**只读，没有任何副作用**：
/// 不写设置、不入队、不起线程、不发一个网络请求。
///
/// 它存在的唯一理由是确认框的先后顺序。`ai_enable(true)` 本身就是「真的开」，
/// 拿它的回执去弹确认框，等于用户看见问句时钱已经在烧了——点「取消」也追不回
/// 那之前漏出去的 embedding 请求。所以确认框的数字从这里取，
/// `ai_enable` 退回它本来的位置：确认之后才执行。
#[tauri::command]
pub fn ai_preview_index(state: State<'_, AppState>) -> CmdResult<EnableReport> {
    let conn = conn!(state);
    Ok(EnableReport {
        pending_notes: index::indexable_note_count(&conn)?,
    })
}

/// 开 / 关 AI。**调用方应当先用 `ai_preview_index` 让用户确认过**——
/// 走到这里就已经是在花钱了。
///
/// 置真时的顺序是死的：**先把 `ai.enabled` 写进库，再 spawn worker**。
/// 反过来的话 worker 第一轮醒来读到的还是 `false`，什么都不做就回去睡，
/// 用户要白等一个 tick（30 秒）才看到进度动起来。
#[tauri::command]
pub fn ai_enable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    enabled: bool,
) -> CmdResult<EnableReport> {
    let pending_notes = {
        let conn = conn!(state);
        meshmind_core::settings::set(
            &conn,
            settings::KEY_AI_ENABLED,
            settings::write_bool(enabled),
        )?;
        if enabled {
            // 开启时全量入队：之前写的笔记一篇都没被向量化过。
            index::enqueue_all(&conn, now_ms())?;
        }
        index::pending_count(&conn)?
    };

    if enabled {
        {
            let mut slot = state.ai.wake.lock().expect("AI 唤醒通道锁已中毒");
            // 重复调用不该起第二个线程。
            if slot.is_none() {
                *slot = Some(worker::spawn(app.clone()));
            }
        }
        // 唤醒要在放掉上面那把锁之后：`wake_worker` 自己也要锁同一个槽位，
        // 攥着它调等于自己锁自己。
        state.ai.wake_worker();
    } else {
        // 关掉 AI 意味着「此后没有任何网络行为」，在飞的提问也算。
        state.ai.cancel_ask();
        // 发送端一丢，worker 的 recv_timeout 拿到 Disconnected，线程自行退出。
        *state.ai.wake.lock().expect("AI 唤醒通道锁已中毒") = None;
        // 内存索引可能是几十上百 MB，关掉就该还给系统。
        *state.ai.index.lock().expect("向量索引锁已中毒") = None;
    }

    Ok(EnableReport { pending_notes })
}

/// 拿当前配置真的发两个请求，验证 Base URL / 密钥 / 模型名都对。
///
/// 没有这个按钮，用户 Base URL 填错一个字符就只能靠猜——真正的报错
/// 要等到后台 worker 跑完一轮才会出现在队列的 last_error 里。
// `(async)`：这个函数是同步的，但它要发两个真实的 HTTP 请求（最坏 60 秒）。
// Tauri 的同步命令跑在主线程上，不加这个属性，用户一点「测试连接」整个界面
// 就冻住——加上之后 Tauri 把它丢进阻塞线程池，主线程照常响应。
#[tauri::command(async)]
pub fn ai_test_connection(state: State<'_, AppState>) -> CmdResult<ConnectionReport> {
    // ---- 锁：只为读一次配置 ----
    let cfg = {
        let conn = conn!(state);
        config::load(&conn)
    };
    // ---- 解锁：两个请求都在无锁状态下发 ----

    if let Some(field) = config::missing(&cfg) {
        return Ok(ConnectionReport {
            embed_ok: false,
            embed_dim: None,
            chat_ok: false,
            error: Some(format!("AI 未配置完整，缺少: {field}")),
        });
    }

    let mut error: Option<String> = None;
    let mut record = |message: String| {
        // 只留第一条：先失败的那个通常才是根因（Base URL 错了会让两条都失败，
        // 把第二条也拼上去只是同一句话说两遍）。密钥可能出现在任何一层错误里，
        // 统一在这里再过一次脱敏。
        if error.is_none() {
            error = Some(http::redact(&message, &cfg.api_key));
        }
    };

    let embed_dim = match test_embed(&cfg) {
        Ok(dim) => Some(dim),
        Err(message) => {
            record(message);
            None
        }
    };
    let chat_ok = match test_chat(&cfg) {
        Ok(()) => true,
        Err(message) => {
            record(message);
            false
        }
    };

    Ok(ConnectionReport {
        embed_ok: embed_dim.is_some(),
        embed_dim,
        chat_ok,
        error,
    })
}

fn test_embed(cfg: &provider::AiConfig) -> Result<usize, String> {
    let request = provider::embed_request(cfg, &["ping".to_string()]).map_err(|e| e.to_string())?;
    let body = http::post(&request, &cfg.api_key)?;
    let vectors = provider::parse_embed_response(cfg.provider, &body).map_err(|e| e.to_string())?;
    match vectors.first() {
        // 维度为 0 的向量等于没有向量：让它冒充成功，用户会以为配好了，
        // 然后对着一个永远搜不到东西的知识库发愁。
        Some(v) if !v.is_empty() => Ok(v.len()),
        _ => Err("Embedding 服务没有返回任何向量".into()),
    }
}

fn test_chat(cfg: &provider::AiConfig) -> Result<(), String> {
    // 单轮问候，非流式：这里要验的是「能不能通」，不是回答质量。
    let messages = [Message::user("你好")];
    let request = provider::chat_request(cfg, &messages, false).map_err(|e| e.to_string())?;
    let body = http::post(&request, &cfg.api_key)?;
    provider::parse_chat_response(cfg.provider, &body).map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空全部向量并重新入队。换 embedding 模型之后必须做一次——
/// 不同模型的向量空间不通用，混在一起检索出来的东西毫无意义。
#[tauri::command]
pub fn ai_reindex_all(state: State<'_, AppState>) -> CmdResult<usize> {
    let queued = {
        let conn = conn!(state);
        index::clear_embeddings(&conn)?;
        index::enqueue_all(&conn, now_ms())?
    };
    // 内存里那份是旧模型的，留着只会让下一次检索拿旧向量去比。
    *state.ai.index.lock().expect("向量索引锁已中毒") = None;
    state.ai.wake_worker();
    Ok(queued)
}

/// 把退避到底、已经不再重试的队列项重新激活。
#[tauri::command]
pub fn ai_retry_failed(state: State<'_, AppState>) -> CmdResult<usize> {
    let reset = {
        let conn = conn!(state);
        index::retry_failed(&conn)?
    };
    state.ai.wake_worker();
    Ok(reset)
}

/// 发起一次提问。**立刻返回**，答案通过 `on_event` 通道流回前端。
///
/// 事件的形状见 [`AskEvent`]。同一时刻只允许一个提问在飞，
/// 新的提问会自动取消上一个。
#[tauri::command]
pub fn ai_ask<R: Runtime>(
    app: AppHandle<R>,
    conversation_id: i64,
    question: String,
    on_event: Channel<AskEvent>,
) -> CmdResult<()> {
    ask::start(app, conversation_id, question, on_event);
    Ok(())
}

/// 取消在飞的提问。没有在飞的提问时什么也不做，不是错误。
#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>) -> CmdResult<()> {
    state.ai.cancel_ask();
    Ok(())
}

/// 语义检索，结果按笔记归并。
///
/// **AI 未启用、未配置完整或查询为空时返回空数组，而不是错误**：搜索框
/// 每敲一个键都会调它，为一个「本来就没开」的功能弹错误横幅不可接受。
// `(async)`：查询要先过一次 embedding 请求。同步命令跑在主线程上，
// 而这个命令是搜索框每敲一个键都会调的——留在主线程上等于每敲一下就卡一次。
#[tauri::command(async)]
pub fn ai_semantic_search<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> CmdResult<Vec<SemanticHit>> {
    if query.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let Some(mut cfg) = usable_config(&state) else {
        return Ok(Vec::new());
    };
    // `top_k` 是**块**的预算，而且它的默认值是按「喂给模型多少片段」定的（6）。
    // 搜索框要的是**笔记**条数，同一篇常常命中好几块——照搬 top_k 会让一次
    // limit = 20 的搜索只剩两三条结果。放宽到 3 倍，再由归并后截断。
    cfg.top_k = (limit as usize).saturating_mul(3).clamp(1, 60);

    let hits = ask::retrieve_for(&app, &cfg, &query)?;
    Ok(merge_by_note(hits, limit as usize))
}

/// 按 `note_id` 归并检索结果：同一篇只留一条，摘要取分数最高的那一块。
///
/// 抽成自由函数是为了能直接单测——这段逻辑走错的表现是搜索结果里同一篇
/// 笔记连着出现五遍、把其他笔记挤出屏幕，而它需要一次真实检索才复现得出来。
/// 不假设入参已经排好序：真相是分数，不是调用方的顺序。
fn merge_by_note(hits: Vec<Retrieved>, limit: usize) -> Vec<SemanticHit> {
    let mut merged: Vec<SemanticHit> = Vec::new();
    for hit in hits {
        match merged.iter_mut().find(|m| m.note_id == hit.note_id) {
            Some(existing) => {
                if hit.score > existing.score {
                    existing.score = hit.score;
                    existing.excerpt = excerpt(&hit.text);
                }
            }
            None => merged.push(SemanticHit {
                note_id: hit.note_id,
                uuid: hit.uuid,
                title: hit.title,
                excerpt: excerpt(&hit.text),
                score: hit.score,
            }),
        }
    }
    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.note_id.cmp(&b.note_id))
    });
    merged.truncate(limit);
    merged
}

/// 摘要按**字符**截断。按字节切会劈开汉字，回显出来是乱码。
fn excerpt(text: &str) -> String {
    text.chars()
        .take(meshmind_core::ai::prompt::EXCERPT_MAX_CHARS)
        .collect()
}

#[tauri::command]
pub fn ai_list_conversations(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<Conversation>> {
    let conn = conn!(state);
    Ok(chat::list_conversations(&conn, limit, offset)?)
}

#[tauri::command]
pub fn ai_create_conversation(state: State<'_, AppState>) -> CmdResult<i64> {
    let conn = conn!(state);
    Ok(chat::create_conversation(&conn, now_ms())?)
}

#[tauri::command]
pub fn ai_get_messages(
    state: State<'_, AppState>,
    conversation_id: i64,
) -> CmdResult<Vec<ChatMessage>> {
    let conn = conn!(state);
    Ok(chat::get_messages(&conn, conversation_id)?)
}

#[tauri::command]
pub fn ai_delete_conversation(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = conn!(state);
    Ok(chat::delete_conversation(&conn, id)?)
}

#[tauri::command]
pub fn ai_rename_conversation(state: State<'_, AppState>, id: i64, title: String) -> CmdResult<()> {
    let conn = conn!(state);
    Ok(chat::rename_conversation(&conn, id, &title)?)
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

    /// 密钥绝不能经 IPC 回到前端。它只该有一条单向的写入路径。
    #[test]
    fn get_settings_never_returns_the_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::initialize(dir.path()).unwrap();
        {
            let conn = state.conn.lock().unwrap();
            meshmind_core::settings::set(&conn, crate::settings::KEY_AI_API_KEY, "sk-secret")
                .unwrap();
            // 顺带放一个普通设置项进去：脱敏不能把别的键也一起抹掉。
            meshmind_core::settings::set(&conn, crate::settings::KEY_AI_BASE_URL, "https://x/v1")
                .unwrap();
        }

        let map = {
            let conn = state.conn.lock().unwrap();
            redact_settings(meshmind_core::settings::get_all(&conn).unwrap())
        };

        assert!(!map.contains_key(crate::settings::KEY_AI_API_KEY));
        assert!(
            !map.values().any(|v| v.contains("sk-secret")),
            "密钥出现在了别的键的值里"
        );
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET)
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            map.get(crate::settings::KEY_AI_BASE_URL)
                .map(String::as_str),
            Some("https://x/v1"),
            "别的设置项要原样透出"
        );
    }

    /// 没设过密钥时合成键是 "false"，不能缺席——前端要靠它决定
    /// 密钥输入框显示「未设置」还是「已设置（留空则不修改）」。
    #[test]
    fn the_synthesised_key_is_false_when_unset() {
        let map = redact_settings(BTreeMap::new());
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET)
                .map(String::as_str),
            Some("false")
        );
    }

    /// 设成空串等同于未设置。
    #[test]
    fn an_empty_api_key_counts_as_unset() {
        let mut input = BTreeMap::new();
        input.insert(crate::settings::KEY_AI_API_KEY.to_string(), String::new());
        let map = redact_settings(input);
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET)
                .map(String::as_str),
            Some("false")
        );
        assert!(!map.contains_key(crate::settings::KEY_AI_API_KEY));
    }

    mod semantic {
        use super::*;
        use meshmind_core::ai::retrieve::Retrieved;

        fn hit(chunk_id: i64, note_id: i64, text: &str, score: f64) -> Retrieved {
            Retrieved {
                chunk_id,
                note_id,
                uuid: format!("u{note_id}"),
                title: format!("笔记{note_id}"),
                heading: String::new(),
                text: text.into(),
                score,
                from_fts: true,
                from_vec: false,
            }
        }

        /// 同一篇笔记命中多个块时列表里只出现一次，摘要取分数最高的那一块。
        /// 少了归并，一篇被切成五块的长笔记会把搜索结果整页占满。
        #[test]
        fn merges_chunks_of_the_same_note_and_keeps_the_best_excerpt() {
            // 故意把高分那块放在后面：归并的依据必须是分数，不是入参顺序。
            let merged = merge_by_note(
                vec![
                    hit(1, 7, "次要的一段", 0.2),
                    hit(2, 9, "另一篇", 0.5),
                    hit(3, 7, "最相关的一段", 0.9),
                ],
                10,
            );

            assert_eq!(merged.len(), 2, "两篇笔记只该有两条结果");
            assert_eq!(merged[0].note_id, 7);
            assert_eq!(merged[0].excerpt, "最相关的一段");
            assert!((merged[0].score - 0.9).abs() < f64::EPSILON);
            assert_eq!(merged[0].uuid, "u7");
            assert_eq!(merged[1].note_id, 9);
        }

        /// 截断发生在归并之后。反过来（先截断再归并）会让 limit = 3 的搜索
        /// 在一篇长笔记霸占前三块时只返回一条结果。
        #[test]
        fn the_limit_counts_notes_not_chunks() {
            let hits = vec![
                hit(1, 7, "甲", 0.9),
                hit(2, 7, "乙", 0.8),
                hit(3, 7, "丙", 0.7),
                hit(4, 8, "丁", 0.6),
                hit(5, 9, "戊", 0.5),
                hit(6, 10, "己", 0.4),
            ];
            let merged = merge_by_note(hits, 3);
            assert_eq!(
                merged.iter().map(|m| m.note_id).collect::<Vec<_>>(),
                vec![7, 8, 9]
            );
        }

        /// 摘要按字符截断。按字节切会劈开汉字，界面上就是一串乱码。
        #[test]
        fn the_excerpt_is_truncated_by_characters() {
            let long = "汉".repeat(meshmind_core::ai::prompt::EXCERPT_MAX_CHARS + 50);
            let merged = merge_by_note(vec![hit(1, 7, &long, 0.5)], 10);
            let excerpt = &merged[0].excerpt;
            assert_eq!(
                excerpt.chars().count(),
                meshmind_core::ai::prompt::EXCERPT_MAX_CHARS
            );
            assert!(excerpt.chars().all(|c| c == '汉'), "截断劈开了汉字");
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

            // 全新的库里没有任何真实设置项，但合成的 `ai.api_key_set` 必须在场：
            // 前端靠它决定密钥输入框显示「未设置」还是「已设置（留空则不修改）」。
            let fresh = invoke(&webview, "get_settings", serde_json::json!({})).unwrap();
            assert_eq!(fresh[crate::settings::KEY_AI_API_KEY_SET], "false");
            assert_eq!(
                fresh.as_object().unwrap().len(),
                1,
                "全新的库里不该有任何真实设置项，实际: {fresh}"
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

        /// 「密钥不经 IPC 回到前端」这件事必须在**真实的往返**上验一次。
        ///
        /// 单测里那条 `get_settings_never_returns_the_api_key` 直接调
        /// `redact_settings`，测的是脱敏规则本身：把 `get_settings` 改回
        /// 直接返回原始 map，它照样绿——函数还在，只是没人调它了。而这
        /// 正是最可能发生的退化（重构时顺手把那层包装拆掉）。这条走一次
        /// 真 invoke，堵的就是「写好了却没接上」。
        #[test]
        fn get_settings_over_ipc_never_leaks_the_api_key() {
            let dir = tempfile::tempdir().unwrap();
            let state = AppState::initialize(dir.path()).unwrap();
            {
                let conn = state.conn.lock().unwrap();
                meshmind_core::settings::set(
                    &conn,
                    crate::settings::KEY_AI_API_KEY,
                    "sk-must-not-leak",
                )
                .unwrap();
            }
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![super::super::get_settings])
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();

            let all = invoke(&webview, "get_settings", serde_json::json!({})).unwrap();
            assert!(
                !all.to_string().contains("sk-must-not-leak"),
                "密钥经 IPC 漏给了前端: {all}"
            );
            assert!(all.get(crate::settings::KEY_AI_API_KEY).is_none());
            assert_eq!(all[crate::settings::KEY_AI_API_KEY_SET], "true");
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
