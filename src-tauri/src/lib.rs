macro_rules! usize_of {
    ($value:expr) => {
        usize::try_from($value).unwrap_or(usize::MAX)
    };
}

mod blocking;
mod cancellation;
mod contract;
mod convert;
mod endpoints;
mod error;
mod export;
mod http;
mod jobs;
mod notes;
mod people;
mod recording;
mod resize;
mod secrets;
mod settings;
mod state;
mod transcription;
mod workspace;

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
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use transcription::commands::{transcript_import, transcription_remote};

pub(crate) const APP_DATA_FOLDER: &str = "com.stratusadv.scribe";

const LOG_FILE_PREFIX: &str = "scribe";
const LOG_FILES_MAX: u8 = 14;
const LOG_FILTER_DEFAULT: &str = "scribe_lib=info,info";
const LOGS_FOLDER: &str = "logs";
const PANIC_LOG_FILE: &str = "panic.log";
const WINDOW_LABEL_MAIN: &str = "main";
const WINDOW_SHOW_FALLBACK_SECONDS: u64 = 3;

#[must_use]
pub fn run() -> ExitCode {
    let log_guard = tracing_start();
    let mut context = tauri::generate_context!();

    devtools_limit(&mut context);
    context_check(&context);
    realtime_cpu_limit_soften();

    let outcome = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            window_setup(app.handle());

            Ok(())
        })
        .on_page_load(page_load_handle)
        .on_window_event(window_event_handle)
        .invoke_handler(invoke_handler())
        .run(context);

    let code = match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(target: "scribe_lib", "tauri exited with an error: {}", error);

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

fn invoke_handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
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
        transcript_correct_streaming,
        notes_save,
        notes_load,
        notes_export,
        notes_print,
        jobs_list,
        jobs_search,
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
        target: "scribe_lib",
        "realtime cpu limit softened to {} of {} microseconds (result {written})",
        limit.rlim_cur,
        limit.rlim_max,
    );
}

#[cfg(not(target_os = "linux"))]
const fn realtime_cpu_limit_soften() {}

fn tracing_start() -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_unset| EnvFilter::new(LOG_FILTER_DEFAULT));

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
        target: "scribe_lib",
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

    #[test]
    fn a_panic_report_is_appended_to_the_panic_log_with_a_timestamp() {
        let directory = std::env::temp_dir().join(format!("scribe-panic-{}", std::process::id()));
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
}
