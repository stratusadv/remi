use crate::blocking;
use crate::contract::{TextRaw, Title};
use crate::error::{AppError, AppResult};
use crate::export::export_last_lock;
use crate::state::AppState;
#[cfg(target_os = "linux")]
use gtk::gio::prelude::FileExt as _;
#[cfg(target_os = "linux")]
use gtk::gio::{AppInfo, AppLaunchContext, BusType, Cancellable, DBusCallFlags, File};
#[cfg(target_os = "linux")]
use gtk::glib::{ToVariant as _, Variant};
#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::path::Path;
use tauri::ipc::Invoke;
use tauri::{AppHandle, State};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_notification::NotificationExt as _;

pub(crate) const COMMAND_PREFIX: &str = "desktop_";
const NOTIFICATION_CHARS_MAX: u32 = 1024;
#[cfg(target_os = "linux")]
const NOTIFICATION_APPLICATION_FALLBACK: &str = "remi-remembers";
#[cfg(target_os = "linux")]
const NOTIFICATION_CALL_TIMEOUT_MS: i32 = 5000;
#[cfg(target_os = "linux")]
const NOTIFICATION_EXPIRE_DEFAULT: i32 = -1;
#[cfg(target_os = "linux")]
const NOTIFICATIONS_BUS_NAME: &str = "org.freedesktop.Notifications";
#[cfg(target_os = "linux")]
const NOTIFICATIONS_INTERFACE: &str = "org.freedesktop.Notifications";
#[cfg(target_os = "linux")]
const NOTIFICATIONS_METHOD: &str = "Notify";
#[cfg(target_os = "linux")]
const NOTIFICATIONS_OBJECT_PATH: &str = "/org/freedesktop/Notifications";
#[cfg(target_os = "linux")]
const NOTIFY_SIGNATURE: &str = "(susssasa{sv}i)";

const _: () = assert!(NOTIFICATION_CHARS_MAX > 0);

#[derive(Clone, Copy, Debug)]
struct Notice<'text> {
    body: &'text str,
    title: &'text str,
}

#[tauri::command]
pub(crate) async fn desktop_export_open(state: State<'_, AppState>) -> AppResult<()> {
    let exported = export_last_lock(&state.export_last)?.clone();

    let path =
        exported.ok_or_else(|| AppError::Export("there is no exported file to open yet".into()))?;

    blocking::run(move || path_open_default(&path)).await
}

#[tauri::command]
pub(crate) async fn desktop_notification_show(
    app: AppHandle,
    title: Title,
    body: TextRaw,
) -> AppResult<()> {
    blocking::run(move || {
        let title_shown = text_bounded(&title);
        let body_shown = text_bounded(&body);

        notification_post(&app, Notice { body: &body_shown, title: &title_shown })
    })
    .await
}

pub(crate) fn invoke_handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![desktop_export_open, desktop_notification_show]
}

#[cfg(target_os = "linux")]
fn application_name() -> String {
    let name = std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|file_name| file_name.to_string_lossy().into_owned()))
        .filter(|file_name| !file_name.is_empty())
        .unwrap_or_else(|| NOTIFICATION_APPLICATION_FALLBACK.to_owned());

    assert_ne!(name, "");
    assert!(!name.contains('/'));

    name
}

#[cfg(target_os = "linux")]
fn notification_parameters(application: &str, notice: Notice<'_>) -> Variant {
    assert_ne!(application, "");
    assert!(notice.title.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));

    let actions: Vec<String> = Vec::new();
    let hints: HashMap<String, Variant> = HashMap::new();

    let parameters = Variant::tuple_from_iter([
        application.to_variant(),
        0_u32.to_variant(),
        application.to_variant(),
        notice.title.to_variant(),
        notice.body.to_variant(),
        actions.to_variant(),
        hints.to_variant(),
        NOTIFICATION_EXPIRE_DEFAULT.to_variant(),
    ]);

    assert_eq!(parameters.type_().as_str(), NOTIFY_SIGNATURE);
    assert_eq!(parameters.n_children(), 8);

    parameters
}

#[cfg(target_os = "linux")]
fn notification_post(_app: &AppHandle, notice: Notice<'_>) -> AppResult<()> {
    assert!(notice.title.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));
    assert!(notice.body.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));

    let connection = gtk::gio::bus_get_sync(BusType::Session, None::<&Cancellable>)
        .map_err(|error| AppError::Task(format!("the session bus is not reachable: {error}")))?;

    let parameters = notification_parameters(&application_name(), notice);

    let reply = connection
        .call_sync(
            Some(NOTIFICATIONS_BUS_NAME),
            NOTIFICATIONS_OBJECT_PATH,
            NOTIFICATIONS_INTERFACE,
            NOTIFICATIONS_METHOD,
            Some(&parameters),
            None,
            DBusCallFlags::NONE,
            NOTIFICATION_CALL_TIMEOUT_MS,
            None::<&Cancellable>,
        )
        .map_err(|error| AppError::Task(format!("the notification was not shown: {error}")))?;

    assert_eq!(reply.n_children(), 1);

    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn notification_post(app: &AppHandle, notice: Notice<'_>) -> AppResult<()> {
    assert!(notice.title.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));
    assert!(notice.body.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));

    app.notification()
        .builder()
        .title(notice.title)
        .body(notice.body)
        .show()
        .map_err(|error| AppError::Task(format!("the notification was not shown: {error}")))
}

#[cfg(target_os = "linux")]
fn path_open_default(path: &Path) -> AppResult<()> {
    assert!(path.file_name().is_some());

    let uri = File::for_path(path).uri();

    assert!(uri.starts_with("file://"));

    AppInfo::launch_default_for_uri(&uri, None::<&AppLaunchContext>).map_err(|error| {
        AppError::Export(format!("{} could not be opened: {error}", path.display()))
    })
}

#[cfg(not(target_os = "linux"))]
fn path_open_default(path: &Path) -> AppResult<()> {
    assert!(path.file_name().is_some());

    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| {
        AppError::Export(format!("{} could not be opened: {error}", path.display()))
    })
}

fn text_bounded(text: &str) -> String {
    let bounded: String = text.trim().chars().take(usize_of!(NOTIFICATION_CHARS_MAX)).collect();

    assert!(bounded.chars().count() <= usize_of!(NOTIFICATION_CHARS_MAX));
    assert!(bounded.len() <= text.len());

    bounded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_text_is_trimmed_and_cut_to_its_bound() {
        let long = "x".repeat(usize_of!(NOTIFICATION_CHARS_MAX) + 7);

        assert_eq!(text_bounded("  Weekly sync  "), "Weekly sync");
        assert_eq!(text_bounded(&long).chars().count(), usize_of!(NOTIFICATION_CHARS_MAX));
        assert_eq!(text_bounded(""), "");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_notification_carries_the_freedesktop_notify_arguments_in_order() {
        let notice = Notice { body: "Weekly sync", title: "Transcribed" };
        let parameters = notification_parameters("remi-remembers", notice);

        assert_eq!(parameters.type_().as_str(), "(susssasa{sv}i)");
        assert_eq!(parameters.child_value(0).str(), Some("remi-remembers"));
        assert_eq!(parameters.child_value(1).get::<u32>(), Some(0));
        assert_eq!(parameters.child_value(3).str(), Some("Transcribed"));
        assert_eq!(parameters.child_value(4).str(), Some("Weekly sync"));
        assert_eq!(parameters.child_value(5).n_children(), 0);
        assert_eq!(parameters.child_value(6).n_children(), 0);
        assert_eq!(parameters.child_value(7).get::<i32>(), Some(-1_i32));
    }
}
