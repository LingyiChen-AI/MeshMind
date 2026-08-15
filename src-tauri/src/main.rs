#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod shortcut;
mod state;
mod tray;
mod window;

use tauri::{Manager, WindowEvent};

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        // 单实例插件必须是链上第一个注册的插件：它在启动流程的最早期决定当前进程
        // 是否让位给已有实例。排到后面，第二个进程已经建好窗口、打开过数据库了——
        // 而两个进程同时写同一个 SQLite 文件轻则互相锁死，重则写坏用户的笔记库。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 用户重复点图标时的期待是「把它调出来」，不是「再开一个」。
            window::show_and_focus(app, window::MAIN);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // 迁移失败必须就地崩溃，绝不静默降级：带着一个半迁移的库继续跑，
            // 后续每一次读写都可能撞上缺失的表或旧结构，最坏情况是悄悄写坏用户数据。
            // 崩溃至少能把数据目录路径摆到用户面前，让问题可诊断、库可备份。
            let state = AppState::initialize(&data_dir).unwrap_or_else(|err| {
                panic!(
                    "初始化数据库失败，数据目录: {}，原因: {err}",
                    data_dir.display()
                )
            });
            app.manage(state);

            // 先注册热键再建托盘：注册失败的说明要作为 tooltip 的一部分交给托盘。
            let hotkey_warning = shortcut::register_capture_hotkey(app.handle());
            tray::setup(app, hotkey_warning)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 常驻托盘应用点叉只收起主窗口。真关掉会连带停掉全局热键和后台捕捉，
                // 而用户点叉时想表达的通常只是「先不看了」。退出的入口在托盘菜单里。
                if window.label() == window::MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_note,
            commands::update_note,
            commands::get_note,
            commands::list_notes,
            commands::delete_note,
            commands::restore_note,
            commands::list_deleted_notes,
            commands::search_notes,
            commands::rebuild_index,
            commands::store_attachment,
            commands::read_attachment,
            commands::collect_garbage,
        ])
        .run(tauri::generate_context!())
        .expect("启动 MeshMind 失败");
}
