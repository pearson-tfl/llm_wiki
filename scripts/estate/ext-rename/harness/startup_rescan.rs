
// pearson-tfl/llm_wiki#3 harness, appended by prove-on-copy.sh to a scratch
// copy of src-tauri/src/commands/file_sync.rs, never to the worktree's own.
// It runs the steps start_project_file_watcher runs before it starts
// watching: the app's startup comparison of a vault against its snapshot.
#[cfg(test)]
mod ext_rename_harness {
    use super::*;

    #[test]
    #[ignore = "needs EXT_RENAME_VAULT; run by prove-on-copy.sh"]
    fn startup_rescan_of_vault_copy() {
        let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let root = PathBuf::from(env("EXT_RENAME_VAULT"));
        let project_id = env("EXT_RENAME_PROJECT_ID");
        let config: SourceWatchConfig =
            serde_json::from_str(&env("EXT_RENAME_WATCH_CONFIG")).expect("watch config JSON");
        let config = normalize_source_watch_config(Some(config));

        ensure_sync_dir(&root).unwrap();
        with_queue_lock(&root, || reset_processing_tasks(&root, &project_id)).unwrap();
        enqueue_startup_rescan_changes(&root, &project_id, &config).unwrap();
        let changed = process_queue_inner(&root, &project_id, |_| {}, |_| {}).unwrap();

        fs::write(
            env("EXT_RENAME_TASKS_OUT"),
            serde_json::to_string_pretty(&changed).unwrap(),
        )
        .unwrap();
    }
}
