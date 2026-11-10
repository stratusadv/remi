#[cfg(target_os = "linux")]
use gtk::gdk;
#[cfg(target_os = "linux")]
use gtk::glib::{self, Propagation, SourceId};
#[cfg(target_os = "linux")]
use gtk::prelude::WidgetExt;
#[cfg(target_os = "linux")]
use std::sync::{Mutex, PoisonError};
#[cfg(target_os = "linux")]
use std::time::Duration;
#[cfg(target_os = "linux")]
use tauri::{LogicalSize, Manager, WebviewWindow};

#[cfg(target_os = "linux")]
#[derive(Default)]
pub(crate) struct ResizeHold(Mutex<Option<SourceId>>);

#[cfg(target_os = "linux")]
const HOLD_DURATION_MAX: Duration = Duration::from_millis(200);

#[cfg(target_os = "linux")]
const HOLD_STATES: gdk::WindowState =
    gdk::WindowState::FULLSCREEN.union(gdk::WindowState::MAXIMIZED).union(gdk::WindowState::TILED);

#[cfg(target_os = "linux")]
fn hold(window: &WebviewWindow) {
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);
    assert!(gtk::is_initialized_main_thread());

    let state = window.state::<ResizeHold>();
    let mut expiry = state.0.lock().unwrap_or_else(PoisonError::into_inner);

    if expiry.is_some() {
        return;
    }

    let Some(gdk_window) = hold_gdk_window(window) else {
        return;
    };

    gdk_window.freeze_updates();

    let owner = window.clone();
    *expiry = Some(glib::timeout_add_local_once(HOLD_DURATION_MAX, move || hold_expire(&owner)));
}

#[cfg(target_os = "linux")]
fn hold_expire(window: &WebviewWindow) {
    let state = window.state::<ResizeHold>();
    let expiry = state.0.lock().unwrap_or_else(PoisonError::into_inner).take();

    assert!(expiry.is_some(), "a resize hold expired after its release");
    assert!(gtk::is_initialized_main_thread());

    tracing::debug!("the resize hold expired before the webview rendered the new size");

    hold_release(window);
}

#[cfg(target_os = "linux")]
fn hold_gdk_window(window: &WebviewWindow) -> Option<gdk::Window> {
    let gdk_window = window.gtk_window().ok()?.window()?;

    assert_eq!(gdk_window.window_type(), gdk::WindowType::Toplevel);
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);

    Some(gdk_window)
}

#[cfg(target_os = "linux")]
fn hold_release(window: &WebviewWindow) {
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);
    assert!(gtk::is_initialized_main_thread());

    let Some(gdk_window) = hold_gdk_window(window) else {
        return;
    };

    gdk_window.thaw_updates();
}

#[cfg(target_os = "linux")]
pub(crate) fn hold_install(window: &WebviewWindow) {
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);
    assert_eq!(window.config().identifier, crate::APP_DATA_FOLDER);

    let managed = window.manage(ResizeHold::default());

    assert!(managed);

    let toplevel = match window.gtk_window() {
        Ok(toplevel) => toplevel,
        Err(error) => {
            tracing::warn!(
                "could not reach the GTK window, resizes will not wait for the webview: {error}"
            );

            return;
        }
    };

    let owner = window.clone();

    let _handler = toplevel.connect_window_state_event(move |_, event| {
        if event.changed_mask().intersects(HOLD_STATES) {
            hold(&owner);
        }

        Propagation::Proceed
    });
}

#[cfg(not(target_os = "linux"))]
pub(crate) const fn hold_install(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "linux")]
#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn window_resize_rendered(window: WebviewWindow, size: LogicalSize<i32>) {
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);
    assert!(size.height >= 0_i32);
    assert!(size.width >= 0_i32);

    let owner = window.clone();

    let dispatched =
        window.run_on_main_thread(move || window_resize_rendered_callback(&owner, size));

    if let Err(error) = dispatched {
        tracing::warn!("could not reach the main thread to release the resize hold: {error}");
    }
}

#[cfg(target_os = "linux")]
fn window_resize_rendered_callback(window: &WebviewWindow, size: LogicalSize<i32>) {
    assert_eq!(window.label(), crate::WINDOW_LABEL_MAIN);
    assert!(gtk::is_initialized_main_thread());
    assert!(size.height >= 0_i32);
    assert!(size.width >= 0_i32);

    let Ok(content) = window.default_vbox() else {
        return;
    };

    let allocation = content.allocation();

    if LogicalSize::new(allocation.width(), allocation.height()) != size {
        return;
    }

    let state = window.state::<ResizeHold>();

    let Some(expiry) = state.0.lock().unwrap_or_else(PoisonError::into_inner).take() else {
        return;
    };

    let () = expiry.remove();
    hold_release(window);
}

#[cfg(not(target_os = "linux"))]
#[tauri::command(rename_all = "snake_case")]
pub(crate) const fn window_resize_rendered(_size: tauri::LogicalSize<i32>) {}
