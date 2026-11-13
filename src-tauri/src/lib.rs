macro_rules! usize_of {
    ($value:expr) => {
        usize::try_from($value).unwrap_or(usize::MAX)
    };
}

mod account;
mod blocking;
mod cancellation;
mod contract;
mod convert;
mod desktop;
mod endpoints;
mod error;
mod export;
mod http;
mod jobs;
mod notes;
mod people;
mod recording;
mod resize;
mod search;
mod secrets;
mod settings;
mod state;
mod stripe_tls;
mod transcription;
mod workspace;

use account::{
    account_checkout_finish,
    account_checkout_start,
    account_code_get,
    account_create,
    account_get,
    account_promo_redeem,
    account_sign_in,
    account_status,
};
use cancellation::task_cancel;
use chrono::Local;
use contract::Markdown;
use endpoints::commands::{endpoints_list, service_api_key_set, service_status};
use error::AppResult;
use export::{notes_export, notes_print};
use jobs::commands::{
    job_audio_clip_get,
    job_audio_path_get,
    job_delete,
    job_meta_get,
    job_meta_update,
    job_transcript_engines_list,
    job_transcript_load,
    job_transcript_save,
    job_waveform_get,
    jobs_list,
    jobs_search,
};
use jobs::folders::{folder_create, folder_remove, folder_rename, folders_list};
use notes::ask::{notes_ask_streaming, notes_ask_warm};
use notes::chats::{chat_get, chat_remove, chat_save, chats_list};
use notes::commands::{
    notes_generate_remote_streaming,
    notes_load,
    notes_models_list,
    notes_save,
    notes_template_delete,
    notes_template_generate,
    notes_template_save,
    notes_templates_list,
    notes_text_rewrite_streaming,
    transcript_correct_streaming,
};
use people::commands::{
    group_remove,
    group_save,
    groups_list,
    people_list,
    person_remove,
    person_save,
};
use recording::{
    microphone_permission_install,
    recording_append,
    recording_discard,
    recording_finish,
    recording_start,
    recordings_directory_default,
};
use resize::window_resize_rendered;
use search::vector::{search_status, search_vectors_refresh};
use settings::commands::{settings_get, settings_update};
use state::AppState;
use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;
use tauri::ipc::Invoke;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WindowEvent};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use transcription::commands::{transcript_import, transcription_remote};
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ContextMenuItemCollection,
    ICoreWebView2ContextMenuRequestedEventArgs,
    ICoreWebView2ContextMenuRequestedEventHandler,
    ICoreWebView2ContextMenuTarget,
    ICoreWebView2Controller,
};

pub(crate) const APP_DATA_FOLDER: &str = "com.stratusadv.remi";

const APP_DATA_FOLDER_LEGACY: &str = "com.stratusadv.scribe";
const DATA_FOLDER_MOVE_ATTEMPTS_MAX: u32 = 10;
const DATA_FOLDER_MOVE_RETRY_DELAY: Duration = Duration::from_millis(250);
const LOG_FILE_PREFIX: &str = "remi";
const LOG_FILES_MAX: u8 = 14;
const LOG_FILTER_VARIABLE: &str = "RUST_LOG";
const LOG_LEVEL_DEFAULT: LevelFilter = LevelFilter::INFO;
const LOGS_FOLDER: &str = "logs";

#[cfg(any(windows, test))]
const MENU_COMMANDS_KEPT: [&str; 7] =
    ["copy", "cut", "paste", "redo", "selectAll", "spellcheck", "undo"];

#[cfg(any(windows, test))]
const MENU_ENTRIES_MAX: u32 = 64;
const PANIC_LOG_FILE: &str = "panic.log";
const WINDOW_LABEL_MAIN: &str = "main";
const WINDOW_SHOW_FALLBACK_SECONDS: u64 = 3;

#[derive(Debug)]
enum DataFolderMove {
    CurrentPresent,
    Failed(std::io::Error),
    LegacyAbsent,
    Moved,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Eq, PartialEq)]
enum MenuEntry {
    Command(String),
    Separator,
}

pub fn run() -> ExitCode {
    let data_folder = dirs::data_dir().map(|data_directory| data_folder_move(&data_directory));

    if let Some(DataFolderMove::Failed(error)) = &data_folder {
        drop(tracing_subscriber::fmt().try_init());

        tracing::error!(
            target: "remi_lib",
            "could not move {APP_DATA_FOLDER_LEGACY} to {APP_DATA_FOLDER}: {error}",
        );

        return ExitCode::FAILURE;
    }

    let log_guard = tracing_start();
    let mut context = tauri::generate_context!();

    if let Some(outcome) = &data_folder {
        data_folder_move_log(outcome);
    }

    devtools_limit(&mut context);
    context_check(&context);
    realtime_cpu_limit_soften();

    #[cfg(not(target_os = "linux"))]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(target_os = "linux")]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let outcome = builder
        .manage(AppState::new())
        .setup(|app| {
            window_setup(app.handle());
            search::reconcile_spawn();
            search::vector::worker_spawn();

            Ok(())
        })
        .on_page_load(page_load_handle)
        .on_window_event(window_event_handle)
        .invoke_handler(invoke_handler)
        .run(context);

    let code = match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(target: "remi_lib", "tauri exited with an error: {}", error);

            ExitCode::FAILURE
        }
    };

    drop(log_guard);

    code
}

#[tauri::command(rename_all = "snake_case")]
async fn app_relaunch(app: AppHandle) {
    app.restart();
}

#[cfg(target_os = "linux")]
fn browser_features_limit(window: &tauri::WebviewWindow) {
    use webkit2gtk::{HitTestResultExt, WebViewExt};

    assert_eq!(window.label(), WINDOW_LABEL_MAIN);

    if !cfg!(optimized) {
        return;
    }

    let installed = window.with_webview(|webview| {
        let _handler = webview.inner().connect_context_menu(|_, _, _, hit_test_result| {
            !hit_test_result.context_is_editable()
        });
    });

    if let Err(error) = installed {
        tracing::warn!("the native context menu limit was not installed: {error}");
    }
}

#[cfg(windows)]
fn browser_features_limit(window: &tauri::WebviewWindow) {
    assert_eq!(window.label(), WINDOW_LABEL_MAIN);

    if !cfg!(optimized) {
        return;
    }

    let installed = window.with_webview(|webview| {
        if let Err(error) = browser_features_limit_controller(&webview.controller()) {
            tracing::warn!("the WebView2 browser features were not limited: {error}");
        }
    });

    if let Err(error) = installed {
        tracing::warn!("the WebView2 browser features were not limited: {error}");
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
const fn browser_features_limit(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn browser_features_limit_controller(
    controller: &ICoreWebView2Controller,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_11, ICoreWebView2Settings3};
    use windows_core::Interface;

    let core = unsafe { controller.CoreWebView2() }?;
    let settings = unsafe { core.Settings() }?.cast::<ICoreWebView2Settings3>()?;
    let mut accelerators = windows_core::BOOL::from(true);

    unsafe { settings.SetAreBrowserAcceleratorKeysEnabled(false) }?;
    unsafe { settings.AreBrowserAcceleratorKeysEnabled(&raw mut accelerators) }?;

    if accelerators.as_bool() {
        tracing::warn!("the WebView2 browser accelerator keys stayed enabled");
    }

    unsafe {
        let menus = core.cast::<ICoreWebView2_11>()?;
        let mut token = 0_i64;

        menus.add_ContextMenuRequested(&browser_features_limit_menu_handler(), &raw mut token)
    }
}

#[cfg(windows)]
fn browser_features_limit_menu_handler() -> ICoreWebView2ContextMenuRequestedEventHandler {
    use webview2_com::ContextMenuRequestedEventHandler;

    ContextMenuRequestedEventHandler::create(Box::new(|_, requested| {
        requested.as_ref().map_or(Ok(()), browser_features_limit_menu_requested)
    }))
}

#[cfg(any(windows, test))]
fn browser_features_limit_menu_kept(menu: &[MenuEntry]) -> Vec<bool> {
    assert!(menu.len() <= usize_of!(MENU_ENTRIES_MAX));

    let mut kept = Vec::with_capacity(menu.len());
    let mut command_last = false;

    for entry in menu {
        let keep = match entry {
            MenuEntry::Command(name) => {
                MENU_COMMANDS_KEPT.iter().any(|command| command.eq_ignore_ascii_case(name))
            }
            MenuEntry::Separator => command_last,
        };

        if keep {
            command_last = matches!(entry, MenuEntry::Command(_));
        }

        kept.push(keep);
    }

    if !command_last {
        let separator_trailing = kept.iter().rposition(|keep| *keep);

        if let Some(separator) = separator_trailing.and_then(|index| kept.get_mut(index)) {
            *separator = false;
        }
    }

    let shown_first = menu.iter().zip(&kept).find(|&(_, &keep)| keep).map(|(entry, _)| entry);
    let shown_last = menu.iter().zip(&kept).rfind(|&(_, &keep)| keep).map(|(entry, _)| entry);

    assert_eq!(kept.len(), menu.len());
    assert_ne!(shown_first, Some(&MenuEntry::Separator));
    assert_ne!(shown_last, Some(&MenuEntry::Separator));

    kept
}

#[cfg(windows)]
fn browser_features_limit_menu_requested(
    arguments: &ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows_core::Result<()> {
    let target = unsafe { arguments.ContextMenuTarget() }?;
    let items = unsafe { arguments.MenuItems() }?;
    let shown = browser_features_limit_menu_shown(&target, &items)?;

    if shown {
        return Ok(());
    }

    unsafe { arguments.SetHandled(true) }
}

#[cfg(windows)]
fn browser_features_limit_menu_shown(
    target: &ICoreWebView2ContextMenuTarget,
    items: &ICoreWebView2ContextMenuItemCollection,
) -> windows_core::Result<bool> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };

    let mut editable = windows_core::BOOL::default();

    unsafe { target.IsEditable(&raw mut editable) }?;

    if !editable.as_bool() {
        return Ok(false);
    }

    let mut count = 0_u32;

    unsafe { items.Count(&raw mut count) }?;

    if count > MENU_ENTRIES_MAX {
        tracing::warn!(
            "the context menu was hidden: {count} entries exceed the {MENU_ENTRIES_MAX} allowed"
        );

        return Ok(false);
    }

    let mut menu = Vec::with_capacity(usize_of!(count));

    for index in 0..count {
        let item = unsafe { items.GetValueAtIndex(index) }?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();

        unsafe { item.Kind(&raw mut kind) }?;

        if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
            menu.push(MenuEntry::Separator);
        } else {
            let mut name = windows_core::PWSTR::null();

            unsafe { item.Name(&raw mut name) }?;

            menu.push(MenuEntry::Command(webview2_com::take_pwstr(name)));
        }
    }

    let kept = browser_features_limit_menu_kept(&menu);
    let kept_count = kept.iter().filter(|&&keep| keep).count();

    assert_eq!(kept.len(), usize_of!(count));

    for (index, keep) in (0..count).zip(&kept).rev() {
        if !keep {
            unsafe { items.RemoveValueAtIndex(index) }?;
        }
    }

    let mut shown = 0_u32;

    unsafe { items.Count(&raw mut shown) }?;

    assert_eq!(usize_of!(shown), kept_count);

    Ok(shown > 0)
}

fn data_folder_move(data_directory: &Path) -> DataFolderMove {
    let legacy = data_directory.join(APP_DATA_FOLDER_LEGACY);
    let current = data_directory.join(APP_DATA_FOLDER);

    assert_ne!(legacy, current);
    assert_eq!(legacy.parent(), current.parent());

    match std::fs::symlink_metadata(&legacy) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DataFolderMove::LegacyAbsent;
        }
        Err(error) => return DataFolderMove::Failed(error),
    }

    match std::fs::symlink_metadata(&current) {
        Ok(_) => return DataFolderMove::CurrentPresent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return DataFolderMove::Failed(error),
    }

    let mut moved = std::fs::rename(&legacy, &current);

    for _attempt in 1..DATA_FOLDER_MOVE_ATTEMPTS_MAX {
        if moved.is_ok() {
            break;
        }

        std::thread::sleep(DATA_FOLDER_MOVE_RETRY_DELAY);
        moved = std::fs::rename(&legacy, &current);
    }

    match moved {
        Ok(()) => {
            assert!(current.exists());
            assert!(!legacy.exists());

            DataFolderMove::Moved
        }
        Err(error) => DataFolderMove::Failed(error),
    }
}

fn data_folder_move_log(outcome: &DataFolderMove) {
    match outcome {
        DataFolderMove::CurrentPresent => {
            tracing::warn!(
                target: "remi_lib",
                "left {APP_DATA_FOLDER_LEGACY} in place because {APP_DATA_FOLDER} already exists",
            );
        }
        DataFolderMove::Failed(error) => {
            unreachable!(
                "a failed data folder move ends the launch before logging starts: {error}"
            );
        }
        DataFolderMove::LegacyAbsent => {}
        DataFolderMove::Moved => {
            tracing::info!(target: "remi_lib", "moved {APP_DATA_FOLDER_LEGACY} to {APP_DATA_FOLDER}");
        }
    }
}

fn devtools_limit(context: &mut tauri::Context<tauri::Wry>) {
    assert_ne!(context.config().app.windows.len(), 0);
    assert_ne!(context.config().identifier.len(), 0);

    for window in &mut context.config_mut().app.windows {
        window.devtools = Some(!cfg!(optimized));
    }

    assert!(context.config().app.windows.iter().all(|window| window.devtools.is_some()));
}

fn context_check(context: &tauri::Context<tauri::Wry>) {
    let config = context.config();

    assert_eq!(config.identifier, APP_DATA_FOLDER);
    assert_eq!(config.app.windows.len(), 1);
    assert!(config.app.windows.iter().any(|window| window.label == WINDOW_LABEL_MAIN));
    assert!(config.app.windows.iter().all(|window| window.background_color.is_some()));
    assert!(config.app.windows.iter().all(|window| !window.visible));
    assert!(config.app.windows.iter().all(|window| window.devtools == Some(!cfg!(optimized))));
}

fn invoke_handler(invoke: Invoke) -> bool {
    assert_ne!(invoke.message.command(), "");

    if invoke.message.command().starts_with(desktop::COMMAND_PREFIX) {
        return desktop::invoke_handler()(invoke);
    }

    invoke_handler_general()(invoke)
}

fn invoke_handler_general() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        task_cancel,
        transcription_remote,
        transcript_import,
        recording_start,
        recording_append,
        recording_finish,
        recording_discard,
        recordings_directory_default,
        endpoints_list,
        service_status,
        service_api_key_set,
        account_status,
        account_get,
        account_code_get,
        account_create,
        account_sign_in,
        account_promo_redeem,
        account_checkout_start,
        account_checkout_finish,
        notes_templates_list,
        notes_template_save,
        notes_template_delete,
        notes_template_generate,
        notes_models_list,
        people_list,
        person_save,
        person_remove,
        groups_list,
        group_save,
        group_remove,
        notes_generate_remote_streaming,
        notes_text_rewrite_streaming,
        notes_ask_streaming,
        notes_ask_warm,
        chat_get,
        chat_remove,
        chat_save,
        chats_list,
        transcript_correct_streaming,
        notes_save,
        notes_load,
        notes_export,
        notes_print,
        jobs_list,
        jobs_search,
        folders_list,
        folder_create,
        folder_rename,
        folder_remove,
        search_status,
        search_vectors_refresh,
        job_meta_get,
        job_meta_update,
        job_delete,
        job_transcript_engines_list,
        job_transcript_load,
        job_transcript_save,
        job_waveform_get,
        job_audio_clip_get,
        job_audio_path_get,
        settings_get,
        settings_update,
        app_relaunch,
        markdown_render_html,
        window_resize_rendered,
    ]
}

fn log_filter_of(requested: Option<&str>) -> Targets {
    let directives = requested.map(str::trim).filter(|text| !text.is_empty());
    let fallback = Targets::new().with_default(LOG_LEVEL_DEFAULT);
    let filter = directives.and_then(|text| text.parse().ok()).unwrap_or(fallback);

    assert!(directives.is_some() || filter.default_level() == Some(LOG_LEVEL_DEFAULT));
    assert!(directives.is_some() || filter.would_enable("remi_lib", &tracing::Level::ERROR));

    filter
}

fn logs_directory_resolve() -> PathBuf {
    let fallback = std::env::temp_dir().join(APP_DATA_FOLDER).join(LOGS_FOLDER);

    let logs_directory = dirs::data_dir()
        .map(|data| data.join(APP_DATA_FOLDER).join(LOGS_FOLDER))
        .filter(|path| std::fs::create_dir_all(path).is_ok())
        .unwrap_or(fallback);

    assert!(logs_directory.ends_with(LOGS_FOLDER));
    assert!(logs_directory.parent().is_some_and(|parent| parent.ends_with(APP_DATA_FOLDER)));
    assert!(logs_directory.file_name().is_some());

    logs_directory
}

#[tauri::command(rename_all = "snake_case")]
async fn markdown_render_html(markdown: Markdown) -> AppResult<String> {
    blocking::run(move || convert::markdown_to_html(&markdown)).await
}

fn page_load_handle(webview: &Webview, payload: &PageLoadPayload<'_>) {
    assert_ne!(webview.label(), "");

    if payload.event() != PageLoadEvent::Finished {
        return;
    }

    if webview.label() == WINDOW_LABEL_MAIN {
        window_show(webview.app_handle());
    }
}

fn panic_log_append(path: &Path, text: &str) -> std::io::Result<()> {
    assert!(path.ends_with(PANIC_LOG_FILE));
    assert_ne!(text.len(), 0);
    assert!(path.parent().is_some());

    let mut file = OpenOptions::new().append(true).create(true).open(path)?;

    writeln!(file, "{} {text}", Local::now().to_rfc3339())
}

fn panic_log_install(logs_directory: &Path) {
    assert!(logs_directory.ends_with(LOGS_FOLDER));

    let path = logs_directory.join(PANIC_LOG_FILE);
    let hook_default = panic::take_hook();

    assert!(path.ends_with(PANIC_LOG_FILE));

    panic::set_hook(Box::new(move |report| {
        if let Err(error) = panic_log_append(&path, &report.to_string()) {
            tracing::error!("could not write the panic log: {}", error);
        }

        hook_default(report);
    }));
}

#[cfg(target_os = "linux")]
fn realtime_cpu_limit_soften() {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    let read = unsafe { libc::getrlimit(libc::RLIMIT_RTTIME, &raw mut limit) };

    if read != 0_i32 {
        return;
    }

    if limit.rlim_max == libc::RLIM_INFINITY {
        return;
    }

    if limit.rlim_cur < limit.rlim_max {
        return;
    }

    limit.rlim_cur = limit.rlim_max.div_euclid(5) * 4;

    let written = unsafe { libc::setrlimit(libc::RLIMIT_RTTIME, &raw const limit) };

    assert!(limit.rlim_cur <= limit.rlim_max);

    tracing::info!(
        target: "remi_lib",
        "realtime cpu limit softened to {} of {} microseconds (result {written})",
        limit.rlim_cur,
        limit.rlim_max,
    );
}

#[cfg(not(target_os = "linux"))]
const fn realtime_cpu_limit_soften() {}

fn tracing_start() -> Option<WorkerGuard> {
    let filter = log_filter_of(std::env::var(LOG_FILTER_VARIABLE).ok().as_deref());
    let logs_directory = logs_directory_resolve();

    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .max_log_files(LOG_FILES_MAX.into())
        .build(&logs_directory);

    let (writer, guard) = match appender {
        Ok(rolling) => {
            let (writer, guard) = tracing_appender::non_blocking(rolling);

            (Some(writer), Some(guard))
        }
        Err(_failed) => (None, None),
    };

    assert_eq!(writer.is_some(), guard.is_some());
    assert!(logs_directory.ends_with(LOGS_FOLDER));

    let file_layer = writer.map(|file_writer| {
        tracing_subscriber::fmt::layer().with_target(true).with_ansi(false).with_writer(file_writer)
    });

    let stdout_layer = tracing_subscriber::fmt::layer().with_target(false).with_ansi(true);

    drop(
        tracing_subscriber::registry().with(filter).with(stdout_layer).with(file_layer).try_init(),
    );

    panic_log_install(&logs_directory);

    tracing::info!(
        target: "remi_lib",
        "logging started, log folder = {}, writing a file = {}",
        logs_directory.display(),
        guard.is_some(),
    );

    guard
}

#[cfg(target_os = "linux")]
fn web_process_recovery_install(window: &tauri::WebviewWindow) {
    use webkit2gtk::WebViewExt;

    assert_eq!(window.label(), WINDOW_LABEL_MAIN);

    let installed = window.with_webview(|webview| {
        let _handler = webview.inner().connect_web_process_terminated(|terminated, reason| {
            tracing::error!("webkit web process terminated ({reason:?}), reloading the page");

            terminated.reload();
        });
    });

    if let Err(error) = installed {
        tracing::warn!("web process recovery handler not installed: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
const fn web_process_recovery_install(_window: &tauri::WebviewWindow) {}

fn window_event_handle(window: &tauri::Window, event: &WindowEvent) {
    assert_ne!(window.label(), "");

    if window.label() != WINDOW_LABEL_MAIN {
        return;
    }

    if matches!(event, WindowEvent::Destroyed) {
        window.app_handle().exit(0);
    }
}

fn window_setup(app: &AppHandle) {
    assert_eq!(app.config().identifier, APP_DATA_FOLDER);
    assert_eq!(app.config().app.windows.len(), 1);

    if let Some(window) = app.get_webview_window(WINDOW_LABEL_MAIN) {
        browser_features_limit(&window);
        microphone_permission_install(&window);
        resize::hold_install(&window);
        web_process_recovery_install(&window);
    }

    window_show_fallback(app);
}

fn window_show(app: &AppHandle) {
    assert_eq!(app.config().identifier, APP_DATA_FOLDER);
    assert!(app.config().app.windows.iter().all(|config| !config.visible));

    let Some(window) = app.get_webview_window(WINDOW_LABEL_MAIN) else {
        return;
    };

    assert_eq!(window.label(), WINDOW_LABEL_MAIN);

    if let Err(error) = window.show() {
        tracing::warn!("the window could not be shown: {error}");
    }
}

fn window_show_fallback(app: &AppHandle) {
    assert_eq!(app.config().identifier, APP_DATA_FOLDER);
    assert!(app.config().app.windows.iter().any(|config| config.label == WINDOW_LABEL_MAIN));

    let _showing = tauri::async_runtime::spawn(window_show_late(app.clone()));
}

async fn window_show_late(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(WINDOW_SHOW_FALLBACK_SECONDS)).await;

    window_show(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn data_folder_fixture(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("remi-data-folder-{name}-{}", std::process::id()));

        if directory.exists() {
            fs::remove_dir_all(&directory).unwrap();
        }

        fs::create_dir_all(&directory).unwrap();

        directory
    }

    #[test]
    fn a_legacy_data_folder_moves_into_place_with_its_contents() {
        let data_directory = data_folder_fixture("moved");
        let legacy = data_directory.join(APP_DATA_FOLDER_LEGACY);
        let notes = Path::new("jobs").join("standup").join("notes.md");

        fs::create_dir_all(legacy.join("jobs").join("standup")).unwrap();
        fs::write(legacy.join(&notes), "# Standup\n").unwrap();

        let outcome = data_folder_move(&data_directory);
        let moved = fs::read_to_string(data_directory.join(APP_DATA_FOLDER).join(&notes)).unwrap();
        let legacy_left = legacy.exists();

        fs::remove_dir_all(&data_directory).unwrap();

        assert!(matches!(outcome, DataFolderMove::Moved));
        assert_eq!(moved, "# Standup\n");
        assert!(!legacy_left);
    }

    #[test]
    fn a_legacy_data_folder_stays_put_when_the_current_one_already_exists() {
        let data_directory = data_folder_fixture("kept");
        let legacy = data_directory.join(APP_DATA_FOLDER_LEGACY);
        let current = data_directory.join(APP_DATA_FOLDER);

        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(legacy.join("settings.json"), "legacy").unwrap();
        fs::write(current.join("settings.json"), "current").unwrap();

        let outcome = data_folder_move(&data_directory);
        let legacy_settings = fs::read_to_string(legacy.join("settings.json")).unwrap();
        let current_settings = fs::read_to_string(current.join("settings.json")).unwrap();

        fs::remove_dir_all(&data_directory).unwrap();

        assert!(matches!(outcome, DataFolderMove::CurrentPresent));
        assert_eq!(legacy_settings, "legacy");
        assert_eq!(current_settings, "current");
    }

    #[test]
    fn nothing_moves_and_nothing_is_created_without_a_legacy_data_folder() {
        let data_directory = data_folder_fixture("absent");
        let current = data_directory.join(APP_DATA_FOLDER);

        let empty = data_folder_move(&data_directory);
        let current_created = current.exists();

        fs::create_dir_all(&current).unwrap();

        let current_only = data_folder_move(&data_directory);
        let current_kept = current.is_dir();

        fs::remove_dir_all(&data_directory).unwrap();

        assert!(matches!(empty, DataFolderMove::LegacyAbsent));
        assert!(!current_created);
        assert!(matches!(current_only, DataFolderMove::LegacyAbsent));
        assert!(current_kept);
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_move_reports_the_failure_and_leaves_the_legacy_folder_whole() {
        use std::os::unix::fs::PermissionsExt;

        let data_directory = data_folder_fixture("refused");
        let legacy = data_directory.join(APP_DATA_FOLDER_LEGACY);

        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("settings.json"), "legacy").unwrap();
        fs::set_permissions(&data_directory, fs::Permissions::from_mode(0o555)).unwrap();

        let outcome = data_folder_move(&data_directory);
        let legacy_settings = fs::read_to_string(legacy.join("settings.json")).unwrap();
        let current_created = data_directory.join(APP_DATA_FOLDER).exists();

        fs::set_permissions(&data_directory, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&data_directory).unwrap();

        assert!(matches!(outcome, DataFolderMove::Failed(_)));
        assert_eq!(legacy_settings, "legacy");
        assert!(!current_created);
    }

    #[test]
    fn the_log_filter_takes_rust_log_directives_and_otherwise_logs_at_the_default_level() {
        let unset = log_filter_of(None);
        let blank = log_filter_of(Some("  "));
        let invalid = log_filter_of(Some("remi_lib=loudest"));
        let narrowed = log_filter_of(Some("remi_lib=debug"));
        let widened = log_filter_of(Some("trace"));

        for fallback in [&unset, &blank, &invalid] {
            assert!(fallback.would_enable("tauri", &tracing::Level::INFO));
            assert!(fallback.would_enable("remi_lib::search", &tracing::Level::WARN));
            assert!(!fallback.would_enable("tauri", &tracing::Level::DEBUG));
        }

        assert!(narrowed.would_enable("remi_lib::search", &tracing::Level::DEBUG));
        assert!(!narrowed.would_enable("remi_lib::search", &tracing::Level::TRACE));
        assert!(!narrowed.would_enable("tauri", &tracing::Level::ERROR));
        assert!(widened.would_enable("hyper", &tracing::Level::TRACE));
    }

    #[test]
    fn a_panic_report_is_appended_to_the_panic_log_with_a_timestamp() {
        let directory = std::env::temp_dir().join(format!("remi-panic-{}", std::process::id()));
        let path = directory.join(PANIC_LOG_FILE);

        fs::create_dir_all(&directory).unwrap();

        panic_log_append(&path, "first report").unwrap();
        panic_log_append(&path, "second report").unwrap();

        let logged = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = logged.lines().collect();

        fs::remove_dir_all(&directory).unwrap();

        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" first report"));
        assert!(lines[1].ends_with(" second report"));
        assert!(!lines[0].starts_with(' '));
        assert_ne!(lines[0], lines[1]);
        assert!(logged.ends_with('\n'));

        let stamp = chrono::DateTime::parse_from_rfc3339(lines[0].split(' ').next().unwrap());

        assert!(stamp.unwrap().timestamp() > 0);
        assert!(!path.exists());
    }

    #[test]
    fn a_separator_shows_only_between_two_groups_that_keep_a_command() {
        let alphabet = [
            (command("copy"), true),
            (command("print"), false),
            (command("SpellCheck"), true),
            (MenuEntry::Separator, false),
        ];

        let mut menus: Vec<Vec<(MenuEntry, bool)>> = vec![Vec::new()];
        let mut checked = 0_u32;

        for _ in 0_u8..=6 {
            for menu in &menus {
                let entries: Vec<MenuEntry> = menu.iter().map(|(entry, _)| entry.clone()).collect();
                let expected = menu_shown_by_groups(menu);
                let shown = menu_shown(&entries);

                let commands: Vec<&MenuEntry> =
                    menu.iter().filter(|(_, kept)| *kept).map(|(entry, _)| entry).collect();

                let commands_shown: Vec<&MenuEntry> =
                    shown.iter().filter(|entry| matches!(entry, MenuEntry::Command(_))).collect();

                let separators_adjacent = shown
                    .windows(2)
                    .any(|pair| matches!(pair, [MenuEntry::Separator, MenuEntry::Separator]));

                assert_eq!(shown, expected, "{entries:?}");
                assert_eq!(commands_shown, commands, "{entries:?}");
                assert!(!separators_adjacent, "{entries:?}");
                assert_ne!(shown.first(), Some(&MenuEntry::Separator), "{entries:?}");
                assert_ne!(shown.last(), Some(&MenuEntry::Separator), "{entries:?}");

                checked += 1;
            }

            menus = menus
                .iter()
                .flat_map(|menu| {
                    alphabet
                        .iter()
                        .map(move |letter| [menu.as_slice(), std::slice::from_ref(letter)].concat())
                })
                .collect();
        }

        assert_eq!(checked, 5461);
    }

    #[test]
    fn an_editable_menu_keeps_spelling_suggestions_and_drops_lookalike_commands() {
        let misspelled = [
            command("spellcheck"),
            command("spellcheck"),
            command("spellcheck"),
            MenuEntry::Separator,
            command("cut"),
            command("copy"),
            command("paste"),
            command("pasteAndMatchStyle"),
        ];

        let misspelled_expected = [
            command("spellcheck"),
            command("spellcheck"),
            command("spellcheck"),
            MenuEntry::Separator,
            command("cut"),
            command("copy"),
            command("paste"),
        ];

        let near = [
            command("copyImage"),
            command("copyLinkLocation"),
            MenuEntry::Separator,
            command("saveImageAs"),
            command("inspectElement"),
        ];

        let empty_shown = menu_shown(&[]);
        let misspelled_shown = menu_shown(&misspelled);
        let near_shown = menu_shown(&near);

        assert_eq!(empty_shown, []);
        assert_eq!(misspelled_shown, misspelled_expected);
        assert_eq!(near_shown, []);
    }

    #[test]
    fn an_editable_menu_shows_only_the_native_edit_commands() {
        let field = [
            command("emoji"),
            MenuEntry::Separator,
            command("other"),
            MenuEntry::Separator,
            command("undo"),
            command("redo"),
            MenuEntry::Separator,
            command("cut"),
            command("copy"),
            command("paste"),
            command("pasteAndMatchStyle"),
            command("selectAll"),
            MenuEntry::Separator,
            command("other"),
        ];

        let field_expected = [
            command("undo"),
            command("redo"),
            MenuEntry::Separator,
            command("cut"),
            command("copy"),
            command("paste"),
            command("selectAll"),
        ];

        let selection = [
            command("emoji"),
            MenuEntry::Separator,
            command("other"),
            MenuEntry::Separator,
            command("cut"),
            command("copy"),
            command("paste"),
            command("pasteAndMatchStyle"),
            command("selectAll"),
            MenuEntry::Separator,
            command("print"),
            command("other"),
        ];

        let selection_expected =
            [command("cut"), command("copy"), command("paste"), command("selectAll")];

        let field_shown = menu_shown(&field);
        let selection_shown = menu_shown(&selection);

        assert_eq!(field_shown, field_expected);
        assert_eq!(selection_shown, selection_expected);
    }

    fn command(name: &str) -> MenuEntry {
        assert_ne!(name, "");

        MenuEntry::Command(name.to_owned())
    }

    fn menu_shown(menu: &[MenuEntry]) -> Vec<MenuEntry> {
        let kept = browser_features_limit_menu_kept(menu);

        assert_eq!(kept.len(), menu.len());

        menu.iter().zip(kept).filter(|(_, keep)| *keep).map(|(entry, _)| entry.clone()).collect()
    }

    fn menu_shown_by_groups(menu: &[(MenuEntry, bool)]) -> Vec<MenuEntry> {
        let groups: Vec<Vec<MenuEntry>> = menu
            .split(|(entry, _)| matches!(entry, MenuEntry::Separator))
            .map(|group| {
                group.iter().filter(|(_, kept)| *kept).map(|(entry, _)| entry.clone()).collect()
            })
            .filter(|group: &Vec<MenuEntry>| !group.is_empty())
            .collect();

        assert!(groups.len() <= menu.len());

        groups.join(&MenuEntry::Separator)
    }
}
