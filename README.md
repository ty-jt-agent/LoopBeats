# LoopBeats

A Web-first multi-track loopstation inspired by the BOSS RC-505. The target is React + TypeScript, Web Audio API + AudioWorklet, and a portable Rust/WASM loop engine.

Priorities: exact loop timing, stable audio, low perceived latency, cross-device support, clear boundaries, testability, and small verifiable slices.

## Start here

1. Clone this repository and open it in Codex. Project skills are committed under `.agents/skills/`.
2. Read `AGENTS.md`, `GLOSSARY.md`, and `docs/development-plan.md`.
3. Setup is configured for GitHub Issues and documentation under `docs/`.
4. Invoke `$grill-with-docs` to resolve requirements, then `$to-spec`, then `$to-tickets` (or the local `$to-issues` alias). Slash forms work in harnesses that support them.
5. Follow the approved [two-track ticket map](docs/specs/two-track-tickets.md). Work a ticket only after its blockers are complete.

## Structure

| Directory               | Responsibility                                    |
| ----------------------- | ------------------------------------------------- |
| `apps/web`              | Browser application, public assets, browser tests |
| `packages/audio-client` | Browser audio host and worklet/WASM bridge        |
| `packages/domain`       | Shared application-facing TypeScript types        |
| `packages/ui`           | Presentation components                           |
| `crates/loop-engine`    | Browser-independent deterministic Rust core       |
| `docs/agents`           | Skills workflow configuration                     |
| `docs/architecture`     | Dependency and real-time boundaries               |
| `docs/adr`              | Architecture decision records                     |
| `docs/research`         | Experiments and browser findings                  |

## Current state

The application starts a microphone/audio-interface session through AudioClient, AudioWorklet and the Rust/WASM engine. Monitoring defaults off and is explicitly controlled. Status, input/output levels and actionable startup errors are visible. Both tracks use a circular **REC/PLAY** control that labels its next action: Record, Finish recording, Play, Overdub, Finish overdub or Retrigger. Track STOP is separate. A stopped Loop plays first; a subsequent press begins overdub. Both tracks record mono input. Either track can establish the first shared cycle; REC again starts continuous Loop playback from zero. An empty second track captures immediately at the current phase, automatically finishes after one elapsed cycle, and retains silence at positions not captured when finished early. Captured sample count and engine-derived progress are visible. Track STOP retains audio; PLAY joins the current cycle or restarts a stopped transport at zero. Global STOP resets transport while retaining completed recordings and discarding unfinished first capture. The 60-second limit and remaining capacity are visible. Only one capture is active; other tracks keep playing. REC on Playing starts immediate additive overdub; REC again returns to playback. The engine supports stopped-Loop overdub, but the performance UI deliberately starts playback before offering overdub. Track/global STOP retain additions. Empty tracks can select One-shot for independent capture and one-pass playback; PLAY retriggers it from the beginning. Stopped recordings can change mode while preserving audio; Loop requires exact shared-cycle length compatibility. CLEAR confirmation defaults on; clearing retains the cycle, and Reset session removes it. Track volume, mute and master volume are available. Mute silences playback without stopping capture or position. The isolated #5/#6 experiment pages remain available for research.

## Environment setup

| Tool            | Requirement                                                                          | Install                                                                          |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Node.js and npm | Node 24 is the tested development/CI version; npm comes with Node                    | [Official Node.js downloads](https://nodejs.org/en/download) — select version 24 |
| Rust and Cargo  | Install through rustup; required for application startup/build, WASM and Rust checks | [Official Rust installer](https://rust-lang.org/tools/install/)                  |
| Git             | Required to clone/update this repository                                             | Verify with `git --version`                                                      |

### Windows (PowerShell)

1. Install Node 24 using the Windows installer. If you already use a Node version manager, select Node 24 through that manager instead.
2. Download and run `rustup-init.exe` from the Rust installation page. Accept the default MSVC toolchain. Install the Visual Studio C++ build tools if prompted; select **Desktop development with C++** with its MSVC tools and Windows SDK. See [Microsoft's Windows Rust setup guide](https://learn.microsoft.com/en-us/windows/dev-environment/rust/setup).
3. Close and reopen PowerShell after installation. If using an integrated terminal, restart VS Code as well so it receives the updated PATH.
4. Verify the tools before starting the application:

```powershell
node --version       # Expected: v24.x
npm --version
cargo --version
rustup --version
git --version
```

Clone the repository if you do not already have it:

```powershell
git clone https://github.com/ty-jt-agent/LoopBeats.git
cd LoopBeats
```

In an existing clone, open PowerShell in its root directory. Run `rustup show` there: `rust-toolchain.toml` selects Rust 1.98.1, rustfmt, clippy and the `wasm32-unknown-unknown` target. Rustup downloads the selected toolchain/target on first use; allow that download to finish.

### macOS / Linux

Install Node 24 and Rust using the official links above. After rustup installation, open a new terminal or run `source "$HOME/.cargo/env"` to load Cargo into PATH. Verify `node --version`, `npm --version`, `cargo --version` and `rustup --version`, then clone/open the repository and run `rustup show` from its root.

### Troubleshooting: `spawnSync cargo ENOENT`

This means the build script cannot find Cargo. Cargo is installed by rustup, not by `npm ci`. First run `Get-Command cargo` in PowerShell. If Cargo is missing, check whether the executable exists:

```powershell
Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe"
```

If this returns `False`, install Rust using the steps above. If it returns `True`, reopen your terminal/editor or add the default Rust directory for the current PowerShell session:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo --version
```

For a permanent fix, add `%USERPROFILE%\.cargo\bin` to your Windows user PATH and restart the terminal/editor. If you chose a custom Cargo installation directory, use that directory instead. A Node 22 installation is a separate environment mismatch: select Node 24 and reopen the terminal before running `npm ci` again.

## Run locally

After verifying the environment, run from the repository root:

```bash
npm ci
npm run dev
```

The dev command builds the real audio assets first, so Cargo must be on PATH. Open the local URL printed by Vite (normally http://localhost:5173). Click **Start audio** and allow microphone access. Use wired headphones, then explicitly **Enable monitoring** to hear live input. **Stop audio** releases the microphone; the next session starts with monitoring off. For a first Loop, press **REC/PLAY — Record**, perform a short phrase, then press **Finish recording**: playback repeats with monitoring still off. **Track STOP** retains the recording, the combined button now offers **Play**, and **Global STOP** resets the shared timeline while retaining completed audio. During the first capture, Track STOP completes it silently; Global STOP discards it. On the other empty track, REC captures one shared cycle starting at the current phase; REC again finishes early with silence elsewhere, while Track STOP retains the full-length result stopped. Global STOP discards unfinished capture and retains completed recordings. **Stop audio** discards this temporary session recording; start a new session to try again. A connected audio interface can be selected as the browser/OS default input; use the Audio input selector under **Settings** to switch while playback and capture are stopped. To layer input onto a playing Loop, press **Overdub**, then **Finish overdub** to finish while playback continues. Only one capture or overdub can be active; the other track can keep playing. To try **One-shot**, select it in an empty track’s playback-mode menu before REC. REC again finishes capture and plays from the beginning once; PLAY retriggers, including during playback. The 60-second limit performs the same completion. One-shot never establishes or changes the shared cycle. Global STOP stops it even when no Loop transport is running. Its combined control plays or retriggers retained audio after capture; rerecording requires CLEAR, and retained recordings can change mode while stopped. Loop requires exact shared-cycle sample length, or establishes the first cycle on PLAY/REC when none exists. Once a shared cycle exists, restart it with Loop PLAY before new capture. Adjust **Track volume**, **Mute/Unmute** and **Master volume** to balance output. Volume controls range from silence to 100%; captured/overdubbed samples stay at full input volume. Monitoring passes through master volume. For a production preview, run `npm run build`, then `npm run preview`.

The two-track performance panel places master controls above adjacent track strips on desktop, with vertical volume faders, independent mute and engine-derived progress. Open **Track details** for sample counts and CLEAR; open **Settings** for input selection, confirmation preferences and reset, or **Diagnostics** for raw engine values. **Stop audio — discard session** releases input and discards recordings; **Global STOP** retains completed audio. Responsive/accessibility coverage and review examples are documented in [the #44 verification record](docs/testing/performance-ui-44.md), and settings/lifecycle safeguards in [the #43 verification record](docs/testing/performance-ui-43.md).

Run `npm run check` for scaffold, type, lint, formatting and TypeScript unit checks. See [development instructions](docs/development.md) for browser, Rust/WASM and CI commands. The [testing strategy](docs/testing/strategy.md) keeps automated checks on every PR and batches routine physical-audio checks in milestone #19 for our single manual tester.

Vendored Matt Pocock skills are MIT licensed, pinned and attributed in `.agents/skills/UPSTREAM.md`. `/to-issues` is local compatibility naming, not an upstream skill.

## Completed session export (#50)

Settings now opens a side panel on desktop and a full-screen panel on narrow
screens. Choose Session for ZIP/recovery/reset, Audio for input selection, or
Preferences for Confirm before clearing. Opening or closing Settings leaves audio
and transfers running; View progress returns to an ongoing transfer. Preferences
apply immediately and report browser-save failures with a retry. See
[the #63 verification record](docs/testing/settings-ui-63.md).

Open **Settings** and choose **Export session** while audio is ready. The ZIP
contains a versioned session manifest and mono float32 WAVs for completed
recordings, preserving raw audio, modes, gain/mute, master gain and shared-cycle
alignment. Unfinished initial recordings are excluded; finish overdub before
exporting. Playback can continue. Cancel or failure leaves the live session
unchanged. See [the export contract](docs/specs/session-export-50.md).

## Session import (#51, #52)

Start audio, finish any recording/overdub, then select **Import session** in
Settings and choose an exported session ZIP. The complete archive is validated
before replacement. When current recordings exist, **Replace current session?**
defaults to Cancel. You can cancel validation or transfer; live playback can
continue until replacement. Changing the current session during import requires
a retry. Imported recordings are Stopped, transport is zero, and monitoring is
off. Modes, track gains/mutes, master gain, shared cycle and raw samples are
preserved for same-rate imports. Different-rate files show both rates and a
fidelity warning before conversion; lowering the rate loses high-frequency
content. Conversion starts only after you accept, followed by replacement
confirmation when recordings exist. Unsupported files and canceled or failed
imports leave the session unchanged. See [the import contract](docs/specs/session-import-51.md)
and [the conversion contract](docs/specs/session-conversion-52.md).

## Completed-session recovery (#53)

Completed recordings and session configuration are checkpointed automatically
in this browser. Changes coalesce for one second, with a five-second scheduling
target when eligible. Playback continues; active overdub postpones saving until
it finishes, and unfinished initial capture is excluded. The last successful
snapshot survives a failed write. Recovery status and the saved time are visible.

After reload, review the recovery offer and explicitly **Start audio** and
**Recover session** to restore Stopped tracks at transport zero with monitoring
off. Rate conversion and replacement use the usual confirmations. **Later**
retains the offer under Settings and pauses saving until recovery or explicit
discard. One tab owns recovery; other tabs can use live audio without overwriting
its snapshot. Retry ownership after the owner closes.

CLEAR, reset, Stop audio—discard session, and accepted import replacement delete
the current workspace's old checkpoint before changing live recordings. CLEAR
then saves the remaining tracks; a crash before that save can lose their recovery.
A pending recovery offer from a previous workspace is preserved until explicitly
recovered or discarded. Browser storage can be cleared, and a crash can lose
changes newer than the last successful snapshot: export ZIPs for portable backup.
See [the recovery contract](docs/specs/session-recovery-53.md).

## Rust/WASM audio experiment (#6)

This isolated feasibility page is separate from the production application. Install Node 24 and Rust via rustup (the repository toolchain installs its WASM target), then run:

```bash
npm ci
npm run spike:wasm
```

Open `/wasm-audio-spike/index.html` on the printed localhost URL. Use wired headphones, Start microphone, then Enable monitoring. The worklet applies a fixed 0.5 gain before monitoring gain. Run the offline probe and Download diagnostics while running. See [the findings and manual checklist](docs/research/wasm-audio-spike.md).

`npm run test:browser` now builds the WASM spike first and requires Cargo on PATH. The generated `gain.wasm` is ignored by git; `npm run spike:wasm:build` regenerates it before serving or building the experiment. Ordinary web development and the application shell remain independent of this page.
