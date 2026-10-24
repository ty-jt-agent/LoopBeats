# Use Tauri 2 as the initial Windows desktop shell

Status: accepted, 2026-10-24.

Use Tauri 2 for Windows window management, local frontend hosting, application lifecycle and the UI-to-host bridge, reusing the React/TypeScript interface in its WebView. Keep Tauri-specific APIs and serialization in the Windows shell and adapter; neither shared UI contracts nor the portable LoopEngine may depend on Tauri. Bundle frontend assets locally and have installation check WebView2 Runtime availability with an installation or recovery path if missing.

Keep WASAPI processing on dedicated native audio threads, independent of WebView responsiveness, Tauri command handlers and async task scheduling. The application contract distinguishes command acceptance from engine application. Bound and rate-limit snapshot and meter delivery outside the audio callback; do not assume Tauri events or channels supply application-level backpressure or acknowledgement guarantees. Keep the Web build independent of Tauri and the Windows toolchain, and validate that UI stalls and heavy IPC traffic do not interrupt native audio processing. This shell choice does not establish a latency guarantee; the native path requires the measurement gates in ADR-0005 and ADR-0006.
