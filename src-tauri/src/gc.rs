//! 启动时的附件垃圾回收。

use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

/// 在后台跑一次附件 GC。
///
/// 放后台而不是同步跑在 `setup` 里：GC 要遍历附件目录并逐个 stat，附件攒到几千个时
/// 这段扫描是以百毫秒计的，而 `setup` 阻塞的正是「窗口出现在屏幕上」之前的那段时间。
/// 用户对启动慢的感知远比对「磁盘上多留一会儿垃圾文件」敏感。
///
/// 用默认宽限期（[`attachments::GC_GRACE_MS`]，1 小时）而不是 0：进程上次是被强杀
/// （崩溃、任务管理器、关机超时）的话，用户粘进快捕窗口但还没保存的图片就留在磁盘上，
/// 数据库里没有任何笔记引用它——从 GC 的视角看和垃圾一模一样。而这类附件恰恰是最不该
/// 删的：用户重新打开应用，多半就是想把上次没写完的东西接着写完。宽限期就是为这段
/// 「已落盘、尚未被引用」的窗口期准备的，启动这一刻正是它最该生效的时刻。
///
/// 失败一律吞掉：GC 是清理动作，没清干净的后果只是磁盘上多几个文件，
/// 而让它把启动流程带崩，后果是用户打不开应用。两者不成比例。
pub fn spawn_startup_gc<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        // 这里不用 `commands.rs` 的 `conn!`（锁中毒即 panic）：那条规则服务的是命令层，
        // panic 能把问题摆到用户面前。后台清理线程里 panic 只会打一行没人看的栈，
        // 还可能顺手把这把锁的中毒状态坐实。读不到锁就放弃这轮 GC。
        let conn = match state.conn.lock() {
            Ok(conn) => conn,
            Err(err) => {
                eprintln!("[MeshMind] 启动 GC 跳过：数据库连接锁不可用（{err}）");
                return;
            }
        };
        match meshmind_core::attachments::collect_garbage(&conn, &state.attachments_root) {
            Ok(0) => {}
            Ok(n) => eprintln!("[MeshMind] 启动 GC 回收了 {n} 个无引用附件"),
            Err(err) => eprintln!("[MeshMind] 启动 GC 失败（不影响使用）: {err}"),
        }
    });
}
