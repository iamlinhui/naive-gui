//! 系统托盘(UI_SPEC §8.1 / DESIGN §9.1 TrayIcon)。
//!
//! 职责:
//! - 常驻托盘图标(左键=显示主窗口,右键=菜单);
//! - 菜单项:状态指示 / 显示主窗口 / 断开连接 / 退出;
//! - 图标 tooltip 与菜单随运行状态刷新([`refresh`]),使窗口隐藏到托盘后
//!   仍能一眼看出连接是「运行中」还是「未连接」;
//! - 「退出」与关闭按钮(minimize_to_tray=false 分支)共用 [`quit_app`]:
//!   停 naive 进程 → 还原系统代理快照(§7.4)→ app.exit。
//!
//! 线程模型:muda 的 [`MenuItem`] 内部为 `Rc<RefCell<..>>`(!Send),故不缓存句柄;
//! 每次刷新经 `run_on_main_thread` + `tray_by_id` 在主线程重建菜单(闭包只 move
//! Send 的 AppHandle/bool)。菜单事件绑定在 tray 级并按 id 分发,重建 menu 不影响。

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::{process, sysproxy};

const TRAY_ID: &str = "main-tray";

/// 统一退出:停进程 + 还原系统代理 + 退出应用。
/// 托盘「退出」与「关闭且不最小化到托盘」都走这里,保证系统代理无残留(§10.4)。
pub async fn quit_app(app: &AppHandle) {
    if let Some(m) = app.try_state::<Arc<process::Manager>>() {
        let _ = m.stop().await;
    }
    sysproxy::cleanup_on_exit(app).await;
    app.exit(0);
}

/// 依运行状态构建菜单。`running` 决定状态项文案与「断开连接」是否可用。
fn build_menu(app: &AppHandle, running: bool) -> tauri::Result<Menu<Wry>> {
    let status_text = if running {
        "● 运行中"
    } else {
        "○ 未连接"
    };
    let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "断开连接", running, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&status, &sep1, &show, &disconnect, &sep2, &quit])
}

fn tooltip(running: bool) -> &'static str {
    if running {
        "NaïveProxy 客户端 · 运行中"
    } else {
        "NaïveProxy 客户端 · 未连接"
    }
}

/// 构建托盘图标(初始未连接态)。在 `setup` 中调用一次。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, false)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(false))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "show" => show_main_window(app),
            "disconnect" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(m) = h.try_state::<Arc<process::Manager>>() {
                        let _ = m.stop().await;
                    }
                });
            }
            "quit" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move { quit_app(&h).await });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击 = 显示主窗口(Windows 习惯:左键唤起,右键弹菜单)
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 刷新托盘 tooltip 与菜单以反映运行状态。可在任意线程调用(内部转主线程)。
/// 由 `manager::emit_state` 在每次状态切换时触发。
pub fn refresh(app: &AppHandle, running: bool) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = h.tray_by_id(TRAY_ID) else {
            return;
        };
        let _ = tray.set_tooltip(Some(tooltip(running)));
        if let Ok(menu) = build_menu(&h, running) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

/// 显示并聚焦主窗口(从托盘或最小化状态唤起)。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
