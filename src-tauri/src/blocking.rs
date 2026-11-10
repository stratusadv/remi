use crate::error::{AppError, AppResult};

pub(crate) async fn run<T, Work>(work: Work) -> AppResult<T>
where
    T: Send + 'static,
    Work: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Task(format!("blocking task failed to join: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_work_runs_off_the_caller_and_hands_back_what_it_produced() {
        let caller = std::thread::current().id();
        let worker = run(|| Ok(std::thread::current().id())).await.unwrap();
        let value = run(|| Ok(7_u8)).await.unwrap();
        let refused: AppResult<u8> = run(|| Err(AppError::Config("refused".into()))).await;
        let text = refused.unwrap_err().to_string();

        assert_ne!(worker, caller);
        assert_eq!(value, 7);
        assert_eq!(text, "config error: refused");
        assert!(text.ends_with("refused"));
    }
}
