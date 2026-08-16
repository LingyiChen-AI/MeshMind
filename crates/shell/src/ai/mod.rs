//! 外壳侧的 AI：配置、HTTP、后台向量化、问答编排。
//!
//! 这里曾经有一行 `#![allow(dead_code)]`：模块写完而命令层还没接上时，
//! 整个模块对 dead_code 分析而言都是不可达的。命令层落地后每个入口都有了
//! 真实调用者，那行 allow 也就随之删掉了——留着只会掩盖真正的死代码。

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
