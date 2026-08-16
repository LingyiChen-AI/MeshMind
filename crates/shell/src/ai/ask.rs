//! 一次问答的完整编排：检索 → 组 prompt → 流式转发。
//!
//! **锁的纪律**（和 `worker` 同一条，但这里更要命）：整段流式回答期间
//! 绝不持有 `AppState.conn`。一个长回答本来就要写好几分钟，期间攥着那把
//! 全应用共用的锁，用户敲的每个字、每一次自动保存都会被卡住——表现就是
//! 「一提问，整个应用就死了」。节奏必须是：
//! 锁 → 写提问、读配置与历史 → 解锁 → 检索（内部自己管锁）→ 无锁流式
//! → 锁 → 落库 → 解锁。
//!
//! 每个持锁区间都用显式作用域框起来，是为了让「锁在哪一行还回去」一眼可见。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use meshmind_core::ai::prompt::{self, Citation};
use meshmind_core::ai::provider::{self, AiConfig, StreamDecoder};
use meshmind_core::ai::retrieve::{self, Retrieved};
use meshmind_core::ai::{chat, index};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};

use crate::ai::{config, http};
use crate::state::AppState;

/// 推给前端的事件。
///
/// serde 的默认外部标签序列化成 `{"Delta":{"text":"…"}}`（无字段的
/// `Cancelled` 则是裸字符串 `"Cancelled"`），前端 `ipc.ts` 按同样的形状解析。
/// 改这里必须同步改那边——TS 编译器看不见 Rust，对不上不会有任何报错，
/// 只会表现为界面安静地什么都不显示。下面的测试把这个形状钉住。
#[derive(Debug, Clone, Serialize)]
pub enum AskEvent {
    Retrieved { citations: Vec<Citation> },
    Delta { text: String },
    Done { message_id: i64 },
    Failed { message: String },
    Cancelled,
}

/// 发起一次提问。**立刻返回**，实际工作在新线程上跑。
///
/// 自己起线程而不是把命令写成 async：外壳没有为 AI 引入 async runtime，
/// 而同步命令由 Tauri 调度到哪个线程属于实现细节——自己起线程，
/// 「不阻塞 IPC 线程」这件事在所有平台上都是确定的。
pub fn start<R: Runtime>(
    app: AppHandle<R>,
    conversation_id: i64,
    question: String,
    channel: Channel<AskEvent>,
) {
    let flag = {
        let state = app.state::<AppState>();
        state.ai.begin_ask()
    };
    std::thread::spawn(move || {
        match run(&app, conversation_id, &question, &channel, &flag) {
            Ok(()) => {}
            // 取消途中冒出来的错误（连接被我们自己断开）不是错误，
            // 弹一条红色横幅只会让用户以为「取消失败了」。
            Err(_) if flag.load(Ordering::SeqCst) => {
                let _ = channel.send(AskEvent::Cancelled);
            }
            Err(message) => {
                let _ = channel.send(AskEvent::Failed { message });
            }
        }
    });
}

fn run<R: Runtime>(
    app: &AppHandle<R>,
    conversation_id: i64,
    question: &str,
    channel: &Channel<AskEvent>,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // ---- 锁：写下提问、读配置与历史 ----
    let (cfg, history) = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        // 关掉 AI 之后不该再有任何网络行为，哪怕配置还留在库里。
        // 少了这一道，一个「配好了但关掉了」的用户仍然会被发出去请求。
        if !config::is_enabled(&conn) {
            return Err("AI 未启用".into());
        }
        let cfg = config::load(&conn);
        if let Some(field) = config::missing(&cfg) {
            return Err(format!("AI 未配置完整，缺少: {field}"));
        }
        // 提问先落库。就算之后失败或取消，界面上也该留下这条没被回答的提问，
        // 而不是让用户敲的字凭空消失。
        chat::append_user(&conn, conversation_id, question, meshmind_core::now_ms())
            .map_err(|e| e.to_string())?;
        let mut history =
            chat::history_for_prompt(&conn, conversation_id).map_err(|e| e.to_string())?;
        // 去掉刚写进去的这一条：它就是当前问题，`prompt::build` 会单独放在最后。
        // 不去掉的话同一个问题会在上下文里出现两遍。
        history.pop();
        (cfg, history)
    };
    // ---- 解锁 ----

    let hits = retrieve_for(app, &cfg, question)?;
    if flag.load(Ordering::SeqCst) {
        let _ = channel.send(AskEvent::Cancelled);
        return Ok(());
    }

    // `citations` 与 `build` 必须喂同一个切片：引用编号的唯一真相是 `hits`
    // 的顺序，两次调用之间对它做任何过滤、重排或截断，模型写的 `[2]`
    // 就会在界面上指到另一篇笔记。
    let citations = prompt::citations(&hits);
    let messages = prompt::build(question, &hits, &history);

    // 检索结果先于任何 Delta 发出：用户要在模型开口之前就看见它读了哪些笔记，
    // 这是「可核验」这条产品主张的实现方式。
    channel
        .send(AskEvent::Retrieved {
            citations: citations.clone(),
        })
        .map_err(|e| e.to_string())?;

    let request = provider::chat_request(&cfg, &messages, true).map_err(|e| e.to_string())?;
    let mut decoder = StreamDecoder::new(cfg.provider);
    let mut answer = String::new();

    // ---- 无锁：整段流式回答期间不持有任何锁 ----
    //
    // 取消也只能靠这个回调：`http::post_stream` 只有一个 600 秒的总超时
    // （blocking 客户端没有「两次读之间」的超时旋钮），指望超时把卡死的连接
    // 拉回来等于让用户干等十分钟。返回 false 会立刻断开连接。
    http::post_stream(&request, &cfg.api_key, |bytes| {
        if flag.load(Ordering::SeqCst) {
            return Ok(false);
        }
        for delta in decoder.push(bytes).map_err(|e| e.to_string())? {
            answer.push_str(&delta);
            channel
                .send(AskEvent::Delta { text: delta })
                .map_err(|e| e.to_string())?;
        }
        Ok(!decoder.is_done())
    })?;
    // ---- 无锁区间结束 ----

    if flag.load(Ordering::SeqCst) {
        let _ = channel.send(AskEvent::Cancelled);
        return Ok(());
    }

    // ---- 锁：落库 ----
    let message_id = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        chat::append_assistant(
            &conn,
            conversation_id,
            &answer,
            &citations,
            meshmind_core::now_ms(),
        )
        .map_err(|e| e.to_string())?
    };
    // ---- 解锁 ----

    channel
        .send(AskEvent::Done { message_id })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 检索：把查询向量化（无锁），再跑一次混合检索（持锁）。`ai_semantic_search` 也走这里。
pub fn retrieve_for<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &AiConfig,
    query: &str,
) -> Result<Vec<Retrieved>, String> {
    let state = app.state::<AppState>();

    // ---- 无锁：把查询向量化。这一行要走网络，慢网络下几秒起步 ----
    let request = provider::embed_request(cfg, &[query.to_string()]).map_err(|e| e.to_string())?;
    let body = http::post(&request, &cfg.api_key)?;
    let mut vectors =
        provider::parse_embed_response(cfg.provider, &body).map_err(|e| e.to_string())?;
    let mut query_vec = vectors.pop().unwrap_or_default();
    // 库里存的是单位向量（`index::write_embedding` 保证），查询也必须归一化，
    // 否则点积算出来的不是余弦相似度，排序整个是歪的。
    meshmind_core::ai::vector::normalize(&mut query_vec);

    // ---- 锁：懒加载内存索引并检索。全是本地读，没有网络 ----
    //
    // 这里同时持有 conn 与 index 两把锁，顺序是 conn → index。worker 那边
    // 从不同时持有这两把（写完向量先放 conn 再拿 index），所以不存在反向加锁。
    // 将来有人要在别处同时拿这两把锁，请沿用同一个顺序。
    let conn = state.conn.lock().expect("数据库连接锁已中毒");
    let mut slot = state.ai.index.lock().expect("向量索引锁已中毒");
    // 懒加载：模型换了、维度对不上或还没装过就重新装。装载是一次全表扫描，
    // 但只在启用 AI 后的第一次检索发生。
    let stale = slot
        .as_ref()
        .is_none_or(|i| i.model() != cfg.embed_model || i.dim() != query_vec.len());
    if stale {
        *slot = Some(
            index::load_index(&conn, &cfg.embed_model, query_vec.len())
                .map_err(|e| e.to_string())?,
        );
    }
    let hits = retrieve::hybrid(&conn, slot.as_ref(), query, Some(&query_vec), cfg.top_k)
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn citation(index: u32) -> Citation {
        Citation {
            index,
            note_id: 42,
            uuid: "u-42".into(),
            title: "部署流程".into(),
            heading: "灰度".into(),
            excerpt: "先构建产物".into(),
        }
    }

    /// 事件的序列化形状是前端契约的一部分。Rust 侧 serde 默认给外部标签
    /// （`{"Delta":{"text":"…"}}`），前端 `ipc.ts` 必须按同样的形状解析。
    /// 这条测试把它钉住——给枚举加个 `#[serde(tag = "…")]` 或 `rename_all`
    /// 而不改前端，界面会安静地什么都不显示，这里会先红。
    #[test]
    fn ask_events_serialise_with_an_external_tag() {
        let json = serde_json::to_value(AskEvent::Delta { text: "甲".into() }).unwrap();
        assert_eq!(json["Delta"]["text"], "甲");

        let json = serde_json::to_value(AskEvent::Done { message_id: 7 }).unwrap();
        assert_eq!(json["Done"]["message_id"], 7);

        let json = serde_json::to_value(AskEvent::Failed {
            message: "网络不通".into(),
        })
        .unwrap();
        assert_eq!(json["Failed"]["message"], "网络不通");

        // 无字段变体是裸字符串，不是 `{"Cancelled":null}`。前端的判别式要认得它。
        let json = serde_json::to_value(AskEvent::Cancelled).unwrap();
        assert_eq!(json, serde_json::json!("Cancelled"));
    }

    /// Retrieved 携带的是完整的引用条目，前端要靠 `index` 把模型写的 `[2]`
    /// 对回某一条、靠 `uuid` 跳到那篇笔记。断言只看「是个数组」太松：
    /// Citation 的字段名改了它照样绿，而前端会拿到一堆 undefined。
    #[test]
    fn retrieved_carries_the_citations() {
        let event = AskEvent::Retrieved {
            citations: vec![citation(1), citation(2)],
        };
        let json = serde_json::to_value(event).unwrap();
        let citations = json["Retrieved"]["citations"]
            .as_array()
            .expect("citations 必须是数组");
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0]["index"], 1);
        assert_eq!(citations[0]["note_id"], 42);
        assert_eq!(citations[0]["uuid"], "u-42");
        assert_eq!(citations[0]["title"], "部署流程");
        assert_eq!(citations[0]["heading"], "灰度");
        assert_eq!(citations[0]["excerpt"], "先构建产物");
        assert_eq!(citations[1]["index"], 2);
    }

    /// 空引用要序列化成 `[]` 而不是 `null`：前端会直接 `.map()` 它。
    #[test]
    fn an_empty_citation_list_is_an_empty_array() {
        let json = serde_json::to_value(AskEvent::Retrieved { citations: vec![] }).unwrap();
        assert_eq!(json["Retrieved"]["citations"], serde_json::json!([]));
    }
}
