use crate::cancellation::CancellationRegistry;
use crate::recording::RecordingSlot;
use std::sync::{Arc, Mutex};

pub(crate) struct AppState {
    pub(crate) cancellation: CancellationRegistry,
    pub(crate) recording: RecordingSlot,
}

impl AppState {
    pub(crate) fn new() -> Self {
        Self { cancellation: CancellationRegistry::new(), recording: Arc::new(Mutex::new(None)) }
    }
}
