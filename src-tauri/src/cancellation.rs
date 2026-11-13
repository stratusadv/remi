use crate::contract::StreamID;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

const STREAM_COUNT_MAX: u32 = 64;

#[derive(Debug)]
pub(crate) struct CancellationRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CancellationRegistry {
    pub(crate) fn clear(&self, stream_id: &str) {
        assert_ne!(stream_id, "");

        let Ok(mut guard) = self.flags.lock() else {
            return;
        };

        drop(guard.remove(stream_id));

        assert!(!guard.contains_key(stream_id));
    }

    pub(crate) fn new() -> Self {
        Self { flags: Mutex::new(HashMap::new()) }
    }

    pub(crate) fn register(&self, stream_id: &str) -> Arc<AtomicBool> {
        assert_ne!(stream_id, "");

        let Ok(mut guard) = self.flags.lock() else {
            return Arc::new(AtomicBool::new(false));
        };

        let held = guard.entry(stream_id.to_owned()).or_insert_with(Arc::default);
        let flag = Arc::clone(held);
        let count = guard.len();

        drop(guard);

        assert!(count >= 1);

        if count > usize_of!(STREAM_COUNT_MAX) {
            tracing::warn!("{count} streams are registered for cancellation at once");
        }

        flag
    }

    pub(crate) fn trigger(&self, stream_id: &str) {
        assert_ne!(stream_id, "");

        let Ok(guard) = self.flags.lock() else {
            return;
        };

        let Some(flag) = guard.get(stream_id) else {
            return;
        };

        flag.store(true, Ordering::SeqCst);

        assert!(flag.load(Ordering::SeqCst));
    }
}

pub(crate) fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

pub(crate) fn stream_id_validate(stream_id: &str) -> AppResult<()> {
    if stream_id.is_empty() {
        return Err(AppError::Config("the stream id is empty".into()));
    }

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn task_cancel(app: AppHandle, stream_id: StreamID) -> AppResult<()> {
    app.state::<AppState>().cancellation.trigger(&stream_id);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flag_is_cancelled_only_after_its_own_stream_is_triggered() {
        let registry = CancellationRegistry::new();
        let flag = registry.register("stream-a");
        let other = registry.register("stream-b");

        registry.trigger("stream-a");

        assert!(is_cancelled(&flag));
        assert!(!is_cancelled(&other));

        registry.clear("stream-a");
        registry.trigger("stream-a");

        assert!(is_cancelled(&flag));
        assert!(!is_cancelled(&registry.register("stream-a")));
    }

    #[test]
    fn an_empty_stream_id_is_refused_at_the_boundary() {
        assert!(stream_id_validate("").is_err());
        stream_id_validate("stream-a").unwrap();
    }

    #[test]
    fn a_trigger_or_clear_for_an_unknown_stream_changes_nothing() {
        let registry = CancellationRegistry::new();

        registry.trigger("ghost");
        registry.clear("ghost");

        let flag = registry.register("ghost");

        assert!(!is_cancelled(&flag));
    }

    #[test]
    fn a_cleared_stream_re_registers_with_a_fresh_flag_while_the_old_one_keeps_its_state() {
        let registry = CancellationRegistry::new();
        let first = registry.register("stream-a");

        registry.clear("stream-a");

        let second = registry.register("stream-a");

        registry.trigger("stream-a");

        assert!(!is_cancelled(&first));
        assert!(is_cancelled(&second));
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn a_handed_out_flag_is_the_one_the_registry_holds_until_it_is_cleared() {
        let registry = CancellationRegistry::new();
        let flag = registry.register("stream-a");
        let observer = Arc::clone(&flag);

        registry.trigger("stream-a");
        registry.trigger("stream-a");

        assert!(is_cancelled(&observer));
        assert_eq!(Arc::strong_count(&flag), 3);

        registry.clear("stream-a");

        assert_eq!(Arc::strong_count(&flag), 2);
        assert!(is_cancelled(&flag));
    }

    #[test]
    fn clearing_one_stream_leaves_the_others_registered() {
        let registry = CancellationRegistry::new();
        let kept = registry.register("stream-a");
        let dropped = registry.register("stream-b");

        registry.clear("stream-b");
        registry.trigger("stream-a");
        registry.trigger("stream-b");

        assert!(is_cancelled(&kept));
        assert!(!is_cancelled(&dropped));
        assert!(!Arc::ptr_eq(&kept, &dropped));
        assert_eq!(Arc::strong_count(&dropped), 1);
    }

    #[test]
    fn a_live_stream_registered_again_shares_its_flag_so_an_early_cancel_still_lands() {
        let registry = CancellationRegistry::new();
        let early = registry.register("stream-a");

        registry.trigger("stream-a");

        let late = registry.register("stream-a");

        assert!(Arc::ptr_eq(&early, &late));
        assert!(is_cancelled(&late));

        registry.clear("stream-a");

        let fresh = registry.register("stream-a");

        assert!(!Arc::ptr_eq(&late, &fresh));
        assert!(!is_cancelled(&fresh));
    }

    #[test]
    fn a_trigger_from_another_thread_is_seen_by_the_flag_holder() {
        let registry = CancellationRegistry::new();
        let flag = registry.register("stream-a");

        std::thread::scope(|scope| {
            scope.spawn(|| registry.trigger("stream-a")).join().unwrap();
        });

        assert!(is_cancelled(&flag));
    }
}
