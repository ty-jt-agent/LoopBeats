# Native WASAPI monitoring prototype

`windows-audio-host` is a device host library and standalone hardware proof
harness. It is not wired into the Tauri UI yet.

On a Windows x64 machine, run the harness from the repository root:

```powershell
cargo run --locked -p windows-audio-host --example monitor
```

It selects the default capture and render endpoints. To choose explicit endpoint
IDs, pass capture ID first and render ID second. Use wired headphones while
monitoring. The harness prints negotiated endpoint/rate/period/buffer/fallback
details, starts native monitoring through `AudioCommand::SetMonitoring`, and
keeps the streams alive until Enter is pressed. It does not measure complete
mic-to-output latency; use the calibrated acoustic procedure in
[`docs/architecture/windows-native.md`](../../docs/architecture/windows-native.md)
and record endpoint driver versions from Device Manager. The endpoint
diagnostics currently state that driver version is unavailable through the
WASAPI binding.
