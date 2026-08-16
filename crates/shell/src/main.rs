#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod gc;
mod quit;
mod settings;
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
        // 开机自启的实际落点在系统里：macOS 写 ~/Library/LaunchAgents/MeshMind.plist，
        // Windows 写注册表 HKCU\...\CurrentVersion\Run。选 LaunchAgent 而不是 AppleScript：
        // AppleScript 那条路要弹「允许 MeshMind 控制 系统事件」的自动化授权，
        // 为一个开关去要一份能操作整个系统的权限，代价和收益完全不成比例。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 更新器：前端启动时静默查一次、设置面板里可以手动查。
        //
        // `tauri.conf.json` 里与之配套的两处配置已经就位：顶层 `plugins.updater`
        // （endpoints 指向 GitHub Release 的 latest.json，pubkey 是签名公钥）
        // 与 `bundle.createUpdaterArtifacts: true`。
        //
        // 两者必须同时存在，改动时别只动一个：只开 `createUpdaterArtifacts` 而没有
        // `plugins.updater`，打包会在「Built application」之后直接失败，报
        // `failed to get updater configuration: plugins > updater doesn't exist`。
        // 这个失败 cargo build 与本地测试都发现不了，只有真打包才会撞上。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新装完要重启应用才生效，relaunch() 在这个插件里。
        .plugin(tauri_plugin_process::init())
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

            // 附件只增不减是个慢性问题：每次粘贴都落一份文件，而没被任何笔记引用的
            // 那些（撤销掉的粘贴、崩溃前没保存的草稿）永远没人来收。启动是唯一一个
            // 「用户还没开始编辑、不会和 GC 抢同一批附件」的时刻。丢后台跑，失败不影响启动。
            gc::spawn_startup_gc(app.handle());

            // 退出协调器要在托盘之前托管好：托盘菜单的「退出」回调会取它。
            quit::setup(app.handle());

            // 读设置决定这一轮的热键与 Dock 图标策略。两者都在拿到 AppState 之后、
            // 建托盘之前：热键注册失败的说明要作为 tooltip 的一部分交给托盘。
            let (configured_hotkey, hide_dock_icon) = {
                let app_state = app.state::<AppState>();
                let conn = app_state.conn.lock().expect("数据库连接锁已中毒");
                let hotkey = meshmind_core::settings::get(&conn, settings::KEY_CAPTURE_HOTKEY)
                    .unwrap_or_else(|err| {
                        eprintln!("[MeshMind] 读取快捕热键设置失败（改用平台默认键）: {err}");
                        None
                    });
                (
                    hotkey,
                    settings::read_bool(&conn, settings::KEY_HIDE_DOCK_ICON),
                )
            };

            // 失败只记一笔：Dock 图标藏没藏成不值得挡住启动，而且用户马上就能在
            // Dock 上看到结果——比任何错误弹窗都直观。
            if let Err(err) = window::set_dock_icon_hidden(app.handle(), hide_dock_icon) {
                eprintln!("[MeshMind] {err}");
            }

            let hotkey_warning = shortcut::setup(app.handle(), configured_hotkey.as_deref());
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
            commands::list_notes_by_tag,
            commands::list_all_tags,
            commands::delete_note,
            commands::restore_note,
            commands::list_deleted_notes,
            commands::purge_note,
            commands::purge_all_deleted,
            commands::search_notes,
            commands::rebuild_index,
            commands::store_attachment,
            commands::read_attachment,
            commands::collect_garbage,
            commands::hide_capture_window,
            commands::confirm_quit,
            commands::get_settings,
            commands::set_setting,
            commands::set_capture_hotkey,
            commands::set_hide_dock_icon,
            commands::set_autostart,
            // AI。这 14 个必须和 commands.rs 里的 `ai_*` 命令一一对上：
            // MVP 阶段有四个命令写完了却没写进这张表，前端调过去只得到
            // 「Command xxx not found」，直到 Playwright 跑起来才发现。
            // `e2e/contract.spec.ts` 现在会守住这条。
            commands::ai_status,
            commands::ai_preview_index,
            commands::ai_enable,
            commands::ai_test_connection,
            commands::ai_reindex_all,
            commands::ai_retry_failed,
            commands::ai_ask,
            commands::ai_cancel,
            commands::ai_semantic_search,
            commands::ai_list_conversations,
            commands::ai_create_conversation,
            commands::ai_get_messages,
            commands::ai_delete_conversation,
            commands::ai_rename_conversation,
        ])
        // 用 build + run 而不是一步到位的 run(context)：只有 `App::run` 这条路
        // 能拿到 `RunEvent` 回调，而 Dock 唤起（macOS 的 Reopen）就藏在里面。
        .build(tauri::generate_context!())
        .expect("启动 MeshMind 失败")
        .run(|app, event| window::on_run_event(app, &event));
}
