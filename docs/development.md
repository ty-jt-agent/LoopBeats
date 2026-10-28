# Development and contribution

## Fresh checkout

Install Node 24+ and npm, and Rust through rustup. The committed toolchain selects Rust 1.98.1, rustfmt, clippy and wasm32-unknown-unknown. Rustup installs these on the first Cargo command. Dependencies are pinned in npm and Cargo lockfiles.

```bash
npm ci
npx playwright install --with-deps chromium
npm run dev
```

Vite prints the development URL (normally http://localhost:5173). The application starts actual Rust/WASM audio processing with explicit monitoring, status and retry controls. Both tracks support mono recording with REC and continuous Loop playback with REC again; either can establish the cycle, and subsequent capture joins the current phase and auto-completes after one elapsed cycle; Track STOP, PLAY, global STOP, remaining capacity and transport state are available. Early completion leaves uncaptured positions silent. Only one capture or overdub is available at a time. REC on a playing Loop starts immediate additive overdub; REC again ends it with playback continuing. REC on a stopped Loop works when transport runs. Track/global STOP retain additions. Empty tracks can select One-shot before capture. One-shot records independently up to 60 seconds, then plays once from zero; PLAY retriggers even during playback. Global STOP stops it without requiring a running Loop transport. Existing One-shot REC stays disabled; stopped recordings can convert modes with exact shared-cycle compatibility. CLEAR preserves the cycle; Reset session removes it. Track/master volume and mute are available; mute does not stop position, capture or overdub. Stop audio discards the temporary recording. Development startup and production builds require Cargo and generate the audio assets automatically. For production preview run `npm run build`, then `npm run preview`.

## Verification commands

Run from the repository root:

| Command | Checks |
| --- | --- |
| `npm run check:scaffold` | Repository structure and skills |
| `npm run typecheck` | Web/shared sources, tests and TypeScript configuration |
| `npm run lint` | TypeScript/React and tooling JavaScript; warnings fail |
| `npm run format:check` | Maintained application and tooling formatting |
| `npm test` | Vitest tests through observable UI boundaries |
| `npm run check` | All five checks above |
| `npm run build` | Compile/copy real audio WASM/worklet, typecheck and production web build |
| `npm run build:audio` | Regenerate production audio assets after Rust/worklet source edits |
| `npm run test:browser` | Build spike WASM and web; Playwright startup and WASM/worklet checks (requires Cargo on PATH) |
| `cargo fmt --all -- --check` | Rust formatting |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | Rust linting |
| `cargo test --locked --workspace` | Rust tests |
| `npm run build:wasm` | Release WASM artifact for portable loop engine |
| `cargo test --locked -p loop-engine` | Run deterministic portable engine tests without desktop shell or audio hardware |
| `cargo test --locked -p windows-audio-host` | Run Windows host's controlled-input tests without requiring physical devices |
| `cargo check --locked --all-targets -p windows-audio-host --target x86_64-pc-windows-msvc` | Check the Windows host for the Windows x64 target |
| `cargo test --locked --manifest-path apps/windows/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc` | Test the Windows shell bridge |
| `npm run tauri:build` | Build the Windows x64 desktop application (Windows toolchain required) |
| `npm run spike:wasm:build` | Build experimental gain WASM and copy to the public spike route |
| `npm run spike:wasm` | Build and open the isolated WASM microphone experiment |

Use `npm run format` and `cargo fmt --all` to format. Existing domain/design documents and vendored skills are excluded from Prettier to preserve their text; review documentation edits directly.

Playwright starts its own preview server at 127.0.0.1:4173 and refuses an occupied port. Chromium must be installed; Linux libraries can be installed by the --with-deps command. Failure traces are retained under test-results.

The WASM artifact is target/wasm32-unknown-unknown/release/loop_engine.wasm. The production engine owns live-input monitoring, two tracks with Loop or One-shot playback and one shared sample transport. Native tests verify exact sample replay, wraparound, capture bounds, monitoring and output protection; browser integration crosses the actual WASM/worklet bridge and verifies both output channels. The separate wasm-gain-spike crate has one known-output gain test and an actual AudioWorklet/WASM bridge with browser integration tests. Its generated artifact is copied to apps/web/public/wasm-audio-spike/gain.wasm (git-ignored). Build it with npm run spike:wasm:build before a production web build if serving that experiment. See docs/research/wasm-audio-spike.md for limits and physical-device checks.

## CI

The public FX editor is included in ordinary production builds. `npm run
test:browser:fx` runs the editor, persistence, input-switching, and recovery
browser cases against the production UI and actual worklet/WASM path. See the
[Input FX contract](specs/input-fx-77.md) for the processing contract and
verification scope. CI runs this suite alongside the full browser suite.

GitHub Actions runs the Web, portable Rust, and Windows jobs on every pull request and main push, so shared package and host changes receive all three relevant checks. The Web job runs Node 24, npm ci, all web checks (including automated platform-boundary checks), browser installation, the committed Rust toolchain, and production browser tests including production audio startup/monitoring, first Loop recording/playback, known-sample stereo output and the compiled WASM spike. Browser verification therefore requires Rust, but it does not invoke Tauri or require a Windows toolchain. The portable Rust job runs formatting, clippy, workspace tests and release WASM build on Linux; `cargo test --locked -p loop-engine` is also available as an isolated engine-only run without a desktop shell or physical audio devices. The Windows job separately checks/tests the WASAPI host and shell bridge, then builds and launches the Windows x64 shell on `windows-2022`. These jobs fail independently, and browser failure artifacts are uploaded.

The automated boundary guard runs with `npm run check`. It checks shared TypeScript package dependencies and imports, keeps concrete browser audio and Tauri APIs in their host adapters, and verifies that `loop-engine` and `native-audio-host` do not introduce Windows, browser, or desktop-shell dependencies. Windows release support is scoped to x64 and Windows 11 Home/Pro versions supported at release time; document the exact minimum and tested Windows builds with the release evidence.

Repository administrators can require both jobs in branch protection; adding a workflow does not configure repository rules.

## Working a ticket

Follow the approved ticket map and parent specification. Implement one verifiable slice per PR. Use agreed seams: deterministic engine output, real browser audio boundary where relevant, and observable UI interactions. Foundation tests do not establish audio feasibility, live latency or cross-device support.

Ready means behavior, vocabulary, blockers, acceptance criteria and seam are understood. Done means specified behavior and appropriate tests pass, required browser evidence exists, docs are updated, review is complete and the PR provides evidence. Revisit architecture every 3–5 substantial feature PRs.

## Manual testing with one tester

The [testing strategy](testing/strategy.md) governs feature versus milestone acceptance. Routine physical checks are batched in #19 using the [shared case catalog](testing/manual-validation.md). Feature PRs retain automated gates and review; their tickets can close after merge with manual verification explicitly deferred to #19. Only concrete hardware-only defects/uncertainties justify an early targeted check. Do not duplicate full checklists or block unrelated development on deferred listening. First-version acceptance still requires the integrated desktop run.
