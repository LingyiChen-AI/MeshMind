#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use tauri::Manager;

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
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
            Ok(())
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
