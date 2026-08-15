//! 退出流程：先给前端一次落盘的机会，再真正退出。
//!
//! 前端的编辑是 800ms 防抖保存的，托盘直接 `app.exit(0)` 会把这个窗口期里的
//! 最后一次编辑连同任何正在排队的写入一起丢掉，而且是**静默**丢掉——用户下次
//! 打开看到的是一份少了最后一段的笔记，却没有任何线索说明发生过什么。
//!
//! 于是退出被拆成两段：Rust 发 [`QUIT_REQUESTED_EVENT`] → 前端落盘 → 前端回调
//! `confirm_quit` → Rust 退出。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 通知前端「准备退出，请把没落盘的东西落盘」。
///
/// 名字是写死的前后端契约，改这里必须同步改前端的 `listen`。
pub const QUIT_REQUESTED_EVENT: &str = "app-quit-requested";

/// 等前端回 `confirm_quit` 的上限。
///
/// 这个兜底不是可选项：前端可能崩了、可能这个版本压根没监听这个事件、可能保存
/// 卡在一次慢磁盘写上。任何一种情况下没有兜底就意味着「点了退出但退不出去」——
/// 用户能做的只剩去任务管理器杀进程，那反而丢得比不等还多。
///
/// 2 秒的取舍：一次防抖保存（800ms）加一次 SQLite 写入在最坏情况下也远在 2 秒内，
/// 同时 2 秒是用户还愿意认为「它在收尾」而不是「它卡死了」的长度上限。
const QUIT_GRACE: Duration = Duration::from_millis(2_000);

/// 退出流程的重入闸门。
///
/// 用户连点两次「退出」是很自然的动作（第一次没立刻退，以为没点上）。没有闸门的话
/// 每一次点击都会起一个定时器，前端也会收到重复的事件——多余的定时器至少浪费一次
/// 强制退出的机会窗口，重复事件则可能让前端把同一份内容重复提交保存。
#[derive(Default)]
pub struct QuitCoordinator {
    pending: AtomicBool,
}

impl QuitCoordinator {
    /// 尝试进入退出流程。返回 `true` 表示本次调用是第一次，应当继续；
    /// `false` 表示已经有一轮退出在进行中，直接忽略。
    fn begin(&self) -> bool {
        // swap 而不是 load + store：两次点击可能来自不同线程，读改写必须是原子的，
        // 否则两边都会读到 false 然后各起一个定时器。
        !self.pending.swap(true, Ordering::SeqCst)
    }
}

/// 托管退出协调器。必须在 `setup` 里调用一次，否则 [`request_quit`] 取不到状态。
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(QuitCoordinator::default());
}

/// 发起一次「优雅退出」。
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<QuitCoordinator>().begin() {
        return;
    }

    // emit 失败说明事件根本没送出去（没有 webview、序列化失败之类），
    // 再等 2 秒是纯粹的空等——没有人会来回 confirm_quit。直接退。
    if let Err(err) = app.emit(QUIT_REQUESTED_EVENT, ()) {
        eprintln!("[MeshMind] 退出事件派发失败（{err}），直接退出");
        app.exit(0);
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        // 走到这里说明前端没在期限内确认。它可能已经存完了只是没回调，也可能压根
        // 没听这个事件——两种情况下用户的诉求都是「退出」，继续等只会更糟。
        eprintln!(
            "[MeshMind] 前端未在 {}ms 内确认退出，强制退出",
            QUIT_GRACE.as_millis()
        );
        app.exit(0);
    });
}

/// 前端已经落盘完毕，可以退了。
pub fn confirm_quit<R: Runtime>(app: &AppHandle<R>) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_wins_and_the_rest_are_ignored() {
        let coordinator = QuitCoordinator::default();
        assert!(coordinator.begin(), "第一次请求应当放行");
        assert!(!coordinator.begin(), "第二次请求应当被闸门挡住");
        assert!(!coordinator.begin(), "之后每一次都应当被挡住");
    }

    /// 连点两次「退出」在真实场景里就是两次几乎同时的回调。这里用多线程压一遍，
    /// 确认无论怎么交错，放行的都只有一个。
    #[test]
    fn only_one_thread_enters_the_quit_flow() {
        let coordinator = std::sync::Arc::new(QuitCoordinator::default());
        let winners: Vec<bool> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16)
                .map(|_| {
                    let coordinator = coordinator.clone();
                    scope.spawn(move || coordinator.begin())
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(
            winners.iter().filter(|w| **w).count(),
            1,
            "并发请求里应当只有一个进入退出流程"
        );
    }
}
