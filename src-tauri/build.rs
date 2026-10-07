fn main() {
    // scripts/estate/check.sh names its checkout here, so that in the target
    // folder shared by every worktree cargo rebuilds this crate whenever the
    // last build came from another checkout, whatever the file times (#104).
    println!("cargo:rerun-if-env-changed=LLM_WIKI_CHECKOUT");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
