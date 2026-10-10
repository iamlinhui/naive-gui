//! naive-gui 入口(DESIGN.md §14)。

mod commands;
mod error;
mod nettest;
mod paths;
mod process;
mod store;
mod sysproxy;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 单实例:聚焦已有窗口
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            // 便携模式首次启动:把 %APPDATA% 既有配置迁移到 <程序目录>/data(§6.4)
            paths::maybe_migrate_from_appdata(&handle);
            let runtime = process::Manager::new(handle.clone());
            app.manage(runtime);

            // 启动自愈:孤儿系统代理快照还原(§10.4)
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                let healed = sysproxy::heal_orphan_snapshot(&h, false)
                    .await
                    .unwrap_or(false);
                if healed {
                    use tauri::Emitter;
                    let _ = h.emit("sysproxy:healed", true);
                }
            });
            // 启动自愈:清理上一实例被强杀/崩溃后遗留的孤儿 naive(pidfile),
            // 否则孤儿一直占着监听端口 → preflight 拒绝 → 用户只看到「端口被占用」
            #[cfg(windows)]
            {
                let h2 = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    process::manager::cleanup_orphan_naive(&h2);
                });
            }
            // 系统托盘(UI_SPEC §8.1):常驻图标 + 显示/断开/退出菜单
            tray::build(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::duplicate_profile,
            commands::reorder_profiles,
            commands::start_runtime,
            commands::stop_runtime,
            commands::runtime_status,
            commands::app_trace,
            commands::test_connectivity,
            commands::sysproxy_status,
            commands::sysproxy_enable,
            commands::sysproxy_disable,
            commands::get_settings,
            commands::set_settings,
            commands::detect_naive_binary,
            commands::resolve_naive_binary,
            commands::open_path,
            commands::get_app_dir,
        ])
        .on_window_event(|window, event| {
            // 关闭按钮 → 按设置项 minimize_to_tray 决定:隐藏到托盘 或 真正退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let win = window.clone();
                if commands::read_minimize_to_tray(&app) {
                    // 最小化到托盘:仅隐藏窗口,naive 进程与系统代理保持不变(后台续跑)
                    let _ = win.hide();
                } else {
                    // 真正退出:停进程 + 还原系统代理(§7.4);quit_app 内 app.exit(0) 终结进程
                    tauri::async_runtime::spawn(async move {
                        tray::quit_app(&app).await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
