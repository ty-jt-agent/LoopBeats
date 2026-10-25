use std::fs;
use std::path::Path;

#[test]
fn native_scheduler_has_no_browser_or_desktop_shell_dependencies() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(manifest.contains("loop-engine"));
    for forbidden in ["tauri", "web-sys", "wasm-bindgen"] {
        assert!(!manifest.to_ascii_lowercase().contains(forbidden));
    }
    assert_no_forbidden_source_imports(&root.join("src"));
}

fn assert_no_forbidden_source_imports(directory: &Path) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            assert_no_forbidden_source_imports(&path);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let source = fs::read_to_string(path).unwrap();
            for forbidden in [
                "tauri::",
                "web_sys",
                "wasm_bindgen",
                "AudioContext",
                "std::fs",
                "std::thread",
                "Mutex<",
                "RwLock<",
            ] {
                assert!(!source.contains(forbidden));
            }
        }
    }
}
