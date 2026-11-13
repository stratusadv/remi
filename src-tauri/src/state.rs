use crate::cancellation::CancellationRegistry;
use crate::notes::ask::WarmThrottle;
use crate::recording::RecordingSlot;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub(crate) struct AppState {
    pub(crate) cancellation: CancellationRegistry,
    pub(crate) export_last: Mutex<Option<PathBuf>>,
    pub(crate) recording: RecordingSlot,
    pub(crate) warm_throttle: WarmThrottle,
}

impl AppState {
    pub(crate) fn new() -> Self {
        Self {
            cancellation: CancellationRegistry::new(),
            export_last: Mutex::new(None),
            recording: Arc::new(Mutex::new(None)),
            warm_throttle: WarmThrottle::default(),
        }
    }
}
