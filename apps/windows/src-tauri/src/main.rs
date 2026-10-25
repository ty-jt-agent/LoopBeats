#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioCapabilities {
    input_device_selection: bool,
    output_device_selection: bool,
    monitoring: bool,
    gain_update_coalescing: bool,
    supported_fx_scopes: Vec<u8>,
}

#[tauri::command]
fn audio_capabilities() -> AudioCapabilities {
    AudioCapabilities {
        input_device_selection: false,
        output_device_selection: false,
        monitoring: false,
        gain_update_coalescing: false,
        supported_fx_scopes: Vec::new(),
    }
}

#[tauri::command]
fn audio_host_start() -> Result<(), String> {
    Err("The native Windows audio host is not included in this shell slice.".into())
}

#[tauri::command]
fn audio_host_stop() {}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            audio_capabilities,
            audio_host_start,
            audio_host_stop
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LoopBeats Windows shell");
}
