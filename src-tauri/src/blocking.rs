use crate::error::{AppError, AppResult};
use tokio::sync::oneshot;

type BlockingWork = Box<dyn FnOnce() + Send>;

pub(crate) async fn run<T, Work>(work: Work) -> AppResult<T>
where
    T: Send + 'static,
    Work: FnOnce() -> AppResult<T> + Send + 'static,
{
    #[cfg(test)]
    let inherited = crate::workspace::test_support::root_override();

    let (sender, receiver) = oneshot::channel::<AppResult<T>>();

    let task: BlockingWork = Box::new(move || {
        #[cfg(test)]
        crate::workspace::test_support::root_adopt(inherited);

        drop(sender.send(work()));
    });

    drop(tokio::task::spawn_blocking(task));

    receiver
        .await
        .map_err(|error| AppError::Task(format!("blocking task failed to join: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_blocking_task_resolves_the_root_of_the_test_that_started_it() {
        let _root = crate::workspace::test_support::root_scoped();
        let caller = crate::workspace::root().unwrap();
        let worker = run(crate::workspace::root).await.unwrap();

        assert_eq!(worker, caller);
        assert!(caller.starts_with(std::env::temp_dir()));
    }

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

    #[tokio::test]
    async fn work_that_panics_reports_a_task_error_instead_of_hanging() {
        let failed: AppResult<u8> = run(|| panic!("the work broke")).await;
        let text = failed.unwrap_err().to_string();

        assert!(text.starts_with("task error: blocking task failed to join"));
        assert_ne!(text, "");
    }
}
