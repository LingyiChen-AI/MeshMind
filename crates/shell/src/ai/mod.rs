//! 外壳侧的 AI：配置、HTTP、后台向量化、问答编排。
//!
//! 整个模块的入口（`worker::spawn`、`begin_ask` / `cancel_ask`、`wake_worker`）
//! 都要等命令层与问答编排接上才会有调用者。在那之前它们对 dead_code 分析而言
//! 全是不可达的，会把 `-D warnings` 的构建整个染红——注意这条 allow 撤不掉的
//! 前提是**整个模块没有任何一个外部调用者**，只补上其中一半（比如现在 worker
//! 已经写完但还没人 spawn 它）并不足以撤销。命令层落地后连同这行一起删掉。
#![allow(dead_code)]

pub mod ask;
pub mod config;
pub mod http;
pub mod worker;

use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use meshmind_core::ai::vector::VectorIndex;

/// AI 的运行期状态。
///
/// **三样东西都是 `None` 起步**，且只在用户真正启用 AI 之后才被填上：
/// 不配置 AI 的用户不会为此付出任何内存或线程的代价，这是方案书
/// 「零依赖启动」的字面要求。
#[derive(Default)]
pub struct AiRuntime {
    /// 内存向量索引。懒加载：首次检索时装载，关闭 AI 时置 None 释放。
    pub index: Mutex<Option<VectorIndex>>,
    /// 当前在飞的提问的取消标志。同一时刻只允许一个提问，
    /// 新提问会先把旧标志置 true。
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 唤醒后台 worker 的通道。worker 未启动时为 None。
    pub wake: Mutex<Option<Sender<()>>>,
}

impl AiRuntime {
    /// 取消在飞的提问（若有），并返回一个属于新提问的标志。
    pub fn begin_ask(&self) -> Arc<AtomicBool> {
        let mut slot = self.cancel.lock().expect("AI 取消标志锁已中毒");
        if let Some(previous) = slot.take() {
            previous.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(Arc::clone(&flag));
        flag
    }

    pub fn cancel_ask(&self) {
        let mut slot = self.cancel.lock().expect("AI 取消标志锁已中毒");
        if let Some(flag) = slot.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// 戳一下 worker 让它立刻干活。worker 没起来时静默忽略——
    /// 那说明 AI 是关的，本来就不该有人在等它。
    pub fn wake_worker(&self) {
        if let Some(tx) = self.wake.lock().expect("AI 唤醒通道锁已中毒").as_ref() {
            let _ = tx.send(());
        }
    }
}
