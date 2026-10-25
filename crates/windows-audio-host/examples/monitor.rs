//! Standalone hardware proof harness. Run on Windows with wired headphones.

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use native_audio_host::AudioCommand;
    use std::io;
    use windows_audio_host::{HostConfig, MonitoringHost};

    let mut args = std::env::args().skip(1);
    let capture_endpoint_id = args.next();
    let render_endpoint_id = args.next();
    let mut host = MonitoringHost::start(HostConfig {
        capture_endpoint_id,
        render_endpoint_id,
        ..HostConfig::default()
    })?;
    println!("Started native WASAPI monitor:");
    println!("{:#?}", host.diagnostics());
    host.commands
        .submit(AudioCommand::SetMonitoring(true))
        .map_err(|error| format!("monitoring command rejected: {error:?}"))?;
    host.commands.flush(1);
    println!("Monitoring enabled through the native engine. Press Enter to stop.");
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    println!("Final diagnostics:\n{:#?}", host.diagnostics());
    host.shutdown();
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The native WASAPI monitor example runs only on Windows.");
}
