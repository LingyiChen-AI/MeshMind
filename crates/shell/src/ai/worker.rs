//! 后台向量化线程。
//!
//! **锁的纪律**：绝不在持有数据库锁时发 HTTP。一次 embedding 调用可能耗时
//! 数十秒，而 `AppState.conn` 是全应用共用的一把锁——期间用户敲的每个字、
//! 每一次搜索、每一次自动保存都会被卡住。节奏必须是：
//! 锁 → 读 → 解锁 → 请求 → 锁 → 写 → 解锁。
//!
//! 每个持锁区间都用显式作用域框起来，是为了让「锁在哪一行还回去」一眼可见。
//! 这条纪律没有自动化测试兜底，只能靠读，所以要读得出来。

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

use meshmind_core::ai::provider::{self, AiConfig};
use meshmind_core::ai::{chunk, index};
use rusqlite::{Connection, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::ai::{config, http};
use crate::state::AppState;

/// 没有新任务时的巡检间隔。
const TICK: Duration = Duration::from_secs(30);
/// 每轮处理多少篇笔记。取小值是为了让线程频繁回到循环顶部：
/// 一轮跑太久，用户关掉 AI 之后 worker 还要吭哧半天才停得下来。
const QUEUE_BATCH_NOTES: usize = 4;
/// 一次 embedding 请求带多少个块。
pub const EMBED_BATCH: usize = 16;

/// 索引进度事件。前端据此更新设置面板上的进度。
pub const PROGRESS_EVENT: &str = "ai://index-progress";

#[derive(Clone, serde::Serialize)]
struct Progress {
    pending: i64,
    indexed: i64,
}

/// 起一个 worker 线程，返回用来唤醒它的发送端。
///
/// 只在 AI 被启用时调用。线程随发送端一起消亡：`AiRuntime.wake` 被置 None 后
/// 通道断开，`recv_timeout` 返回 `Disconnected`，循环退出。
pub fn spawn<R: Runtime>(app: AppHandle<R>) -> Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if let Err(err) = run_once(&app) {
                // 这里的失败已经被记进了队列的 last_error，用户在设置面板能看到。
                // 打一行日志只是为了本地排查，不该让线程倒下。
                eprintln!("[MeshMind] 向量化失败: {err}");
            }
        }
    });
    tx
}

fn run_once<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<AppState>();

    // ---- 锁：读配置与待办 ----
    let (enabled, cfg, due) = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        let enabled = config::is_enabled(&conn);
        let cfg = config::load(&conn);
        // 配置缺一项就别取任务：取了也只能整批失败，白白把 attempts 烧掉，
        // 等用户填完配置反而要先熬过退避才动得起来。
        let due = if enabled && config::missing(&cfg).is_none() {
            index::take_due(&conn, meshmind_core::now_ms(), QUEUE_BATCH_NOTES)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        (enabled, cfg, due)
    };
    // ---- 解锁 ----

    if !enabled || due.is_empty() {
        return Ok(());
    }

    // 一篇失败不牵连其他篇：错误记进它自己那行队列，循环继续。
    for note_id in due {
        if let Err(err) = process(&state, &cfg, note_id) {
            let conn = state.conn.lock().expect("数据库连接锁已中毒");
            let _ = index::record_failure(&conn, note_id, &err, meshmind_core::now_ms());
        }
    }

    emit_progress(app, &state, &cfg);
    Ok(())
}

/// 处理一篇笔记：切块（持锁）→ 逐批向量化（无锁）→ 写回（持锁）。
fn process(state: &tauri::State<'_, AppState>, cfg: &AiConfig, note_id: i64) -> Result<(), String> {
    // ---- 锁：读笔记、切块、写块 ----
    let pending = {
        let mut conn = state.conn.lock().expect("数据库连接锁已中毒");
        match prepare_note(&mut conn, note_id)? {
            Some(pending) => pending,
            // 笔记已经不在了（被删或进了回收站）：`prepare_note` 已经把它请出队列，
            // 这不是错误，走人即可。
            None => return Ok(()),
        }
    };
    // ---- 解锁 ----

    for batch in batches(&pending) {
        let inputs: Vec<String> = batch.iter().map(|(_, text)| text.clone()).collect();
        let request = provider::embed_request(cfg, &inputs).map_err(|e| e.to_string())?;

        // ---- 无锁：发请求。慢网络下这一行可能要走几十秒 ----
        let body = http::post(&request, &cfg.api_key)?;
        let vectors =
            provider::parse_embed_response(cfg.provider, &body).map_err(|e| e.to_string())?;
        check_count(batch.len(), vectors.len())?;

        // ---- 锁：写回向量 ----
        {
            let conn = state.conn.lock().expect("数据库连接锁已中毒");
            for ((chunk_id, _), raw) in batch.iter().zip(&vectors) {
                index::write_embedding(&conn, *chunk_id, &cfg.embed_model, raw)
                    .map_err(|e| e.to_string())?;
            }
        }
        // ---- 解锁 ----

        // 内存索引是另一把锁，单独进出：把它和数据库锁叠在一起持有，
        // 就多出一处可能和别处相反顺序加锁的死锁点，而这里根本不需要同时持有。
        {
            let mut slot = state.ai.index.lock().expect("向量索引锁已中毒");
            if let Some(memory) = slot.as_mut() {
                for ((chunk_id, _), raw) in batch.iter().zip(&vectors) {
                    // 库里存的是单位向量（`index::write_embedding` 保证），
                    // 内存索引也必须归一化，否则同一个块在两条路径下的相似度对不上。
                    let mut v = raw.clone();
                    meshmind_core::ai::vector::normalize(&mut v);
                    memory.upsert(*chunk_id, v);
                }
            }
        }
    }

    // ---- 锁：全部写完才出队 ----
    {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        index::dequeue(&conn, note_id).map_err(|e| e.to_string())?;
    }
    // ---- 解锁 ----
    Ok(())
}

/// 一篇笔记在**持锁期间**该做的全部事情：确认它还在、切块落库、拼出
/// 每个块的 embedding 输入。返回 `None` 表示这篇笔记不必再处理，且已经出队。
///
/// 单独抽成一个只依赖 `Connection` 的函数，一是让持锁区间在 `process` 里
/// 一眼可见（它的开始与结束就是这次调用的开始与结束），二是让「回收站里的
/// 笔记不被向量化」这条能被真正测到——`process` 依赖 `AppHandle`，测不了。
fn prepare_note(conn: &mut Connection, note_id: i64) -> Result<Option<Vec<(i64, String)>>, String> {
    // `deleted_at IS NULL` 是这条查询的重点，不是顺手加的。
    // `notes::soft_delete` 不清空 `embed_queue`，create/update 又是无条件入队的，
    // `index::take_due` 也不看删除状态——不在这里挡一道，回收站里的笔记会被
    // 原样发给服务商：既白花用户的钱，又把用户以为已经删掉的内容重新算进索引。
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT title, body_json FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            [note_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((title, body_json)) = found else {
        // 出队而不是记失败：这不是「这次没成功」，是「这件事不用做了」。
        // 记成失败的话它会在队列里反复重试，直到熬完五次退避才安静下来。
        index::dequeue(conn, note_id).map_err(|e| e.to_string())?;
        return Ok(None);
    };

    let chunks = chunk::split(&body_json).map_err(|e| e.to_string())?;
    index::replace_chunks(conn, note_id, &chunks).map_err(|e| e.to_string())?;
    // 从库里回读而不是直接用 `chunks`：要的是**块的主键**，向量得按它写回去。
    let pending = index::chunks_of(conn, note_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, c)| (id, embed_input(&title, &c.heading, &c.text)))
        .collect();
    Ok(Some(pending))
}

/// 按单次请求的上限分批。用 `chunks` 而不是手写下标：尾巴那一批
/// （长度不足 `EMBED_BATCH` 的那批）最容易在手写循环里被漏掉，
/// 而漏掉的表现是「大部分笔记能搜到，个别搜不到」——极难被发现。
fn batches<T>(items: &[T]) -> std::slice::Chunks<'_, T> {
    items.chunks(EMBED_BATCH)
}

/// 喂给 embedding 的输入：标题与小标题拼在正文前面。
///
/// 一个块脱离了它的语境，向量表达的只是一段悬空的文字。补上这两行的成本是
/// 每块多几十个 token，换来的召回提升远超这个代价。
pub fn embed_input(title: &str, heading: &str, text: &str) -> String {
    if heading.is_empty() {
        format!("{title}\n{text}")
    } else {
        format!("{title}\n{heading}\n{text}")
    }
}

/// 返回条数与请求条数必须一致。按位置 zip 而不校验的话，
/// 少返回一条就会让**之后每一个块**的向量都错位——检索照样能跑，只是全都答非所问。
pub fn check_count(expected: usize, got: usize) -> Result<(), String> {
    if expected == got {
        Ok(())
    } else {
        Err(format!(
            "AI 服务返回的向量条数不对：期望 {expected}，实际 {got}"
        ))
    }
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppState>,
    cfg: &AiConfig,
) {
    // ---- 锁：读两个计数 ----
    let progress = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        Progress {
            pending: index::pending_count(&conn).unwrap_or(0),
            indexed: index::indexed_chunk_count(&conn, &cfg.embed_model).unwrap_or(0),
        }
    };
    // ---- 解锁：事件的投递不该压在数据库锁里 ----
    let _ = app.emit(PROGRESS_EVENT, progress);
}

#[cfg(test)]
mod tests {
    use super::*;
    use meshmind_core::db;
    use meshmind_core::notes::{self, NewNote};
    use serde_json::json;

    fn conn() -> Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    /// 一篇有标题有正文的笔记。
    fn body() -> String {
        json!({
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": { "level": 2 },
                    "content": [{ "type": "text", "text": "部署流程" }]
                },
                {
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": "先构建产物，再推到生产环境。" }]
                }
            ]
        })
        .to_string()
    }

    fn create_note(conn: &mut Connection) -> notes::Note {
        notes::create(
            conn,
            &NewNote {
                body_json: body(),
                attachment_ids: Vec::new(),
            },
            1_000,
        )
        .unwrap()
    }

    /// 分批必须覆盖到全部输入，不能因为整除关系漏掉尾巴。
    #[test]
    fn batches_cover_every_input() {
        const { assert!(EMBED_BATCH > 0, "批量大小为 0 会让分批直接 panic") };
        for total in 0..40usize {
            let inputs: Vec<usize> = (0..total).collect();
            let mut flattened = Vec::new();
            for batch in batches(&inputs) {
                assert!(!batch.is_empty(), "空批次会发出一个没有输入的请求");
                assert!(batch.len() <= EMBED_BATCH, "批次超出了单次请求的上限");
                flattened.extend_from_slice(batch);
            }
            assert_eq!(flattened, inputs, "total = {total}");
        }
    }

    /// embedding 的输入把标题与小标题拼在正文前面。这是检索质量的关键：
    /// 一个块脱离了它的语境，向量表达的就是一段悬空的文字。
    #[test]
    fn embed_input_carries_the_note_title_and_heading() {
        let input = embed_input("笔记标题", "小标题", "正文");
        assert!(input.starts_with("笔记标题"));
        assert!(input.contains("小标题"));
        assert!(input.ends_with("正文"));
    }

    #[test]
    fn embed_input_omits_an_empty_heading_without_leaving_a_blank_line() {
        assert_eq!(embed_input("标题", "", "正文"), "标题\n正文");
    }

    /// 返回的向量条数与请求的块数对不上时必须报错。
    /// 静默按位置配对会让向量与块错位——检索照样能跑，只是全都答非所问。
    #[test]
    fn a_count_mismatch_is_an_error_not_a_silent_zip() {
        assert!(check_count(3, 2).is_err());
        assert!(check_count(3, 3).is_ok());
    }

    /// 正常笔记：切块落库，并把标题拼进每条 embedding 输入。
    #[test]
    fn a_live_note_is_split_into_embed_inputs() {
        let mut conn = conn();
        let note = create_note(&mut conn);

        let pending = prepare_note(&mut conn, note.id)
            .unwrap()
            .expect("笔记还在，不该被跳过");
        assert!(!pending.is_empty(), "有正文的笔记必须切出块来");
        for (_, input) in &pending {
            assert!(
                input.starts_with(&note.title),
                "每条输入都要带上笔记标题，实际是 {input}"
            );
        }
        assert!(
            pending
                .iter()
                .any(|(_, input)| input.contains("先构建产物")),
            "正文必须进入输入"
        );
        // 向量还没写回，这时候不能出队——出早了这篇笔记就再也没人管了。
        assert_eq!(index::pending_count(&conn).unwrap(), 1);
    }

    /// 回收站里的笔记绝不能被送去做 embedding。
    ///
    /// `notes::soft_delete` 不清空 `embed_queue`，而 create/update 是无条件入队的，
    /// `index::take_due` 也不看 `deleted_at`——不在这里挡一道，用户以为删掉的笔记
    /// 会被原样发给服务商，既花钱又把已删内容算回索引。
    #[test]
    fn a_note_in_the_trash_is_dequeued_instead_of_embedded() {
        let mut conn = conn();
        let note = create_note(&mut conn);
        notes::soft_delete(&mut conn, note.id, 2_000).unwrap();
        // 前提确认：软删除确实没把它请出队列，所以 worker 一定会取到它。
        // 哪天 soft_delete 自己清了队列，这条断言会先红，提醒来人重新想一遍。
        assert_eq!(
            index::take_due(&conn, 3_000, 8).unwrap(),
            vec![note.id],
            "软删除若已经清了队列，这条测试就失去了意义"
        );

        assert!(
            prepare_note(&mut conn, note.id).unwrap().is_none(),
            "回收站里的笔记不该产出任何 embedding 输入"
        );
        assert_eq!(
            index::pending_count(&conn).unwrap(),
            0,
            "跳过之后必须出队，否则每一轮巡检都会再捞一次"
        );
    }

    /// 笔记行整个不见了（硬删）同样只是「跳过」，不是失败——
    /// 当成失败会让它在队列里反复重试，直到耗尽退避次数才停。
    #[test]
    fn a_missing_note_is_not_an_error() {
        let mut conn = conn();
        assert!(prepare_note(&mut conn, 4_242).unwrap().is_none());
    }
}
