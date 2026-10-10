# Settings navigation and Preferences (#63)

The Settings container follows the #62 interaction contract: a nonmodal side
panel at 1024 CSS pixels and above, and a full viewport modal below that width.
Session, Audio and Preferences use keyboard-operable tabs. Selection is remembered
for this page only; a reload starts at Session. Audio keeps running through
opening, navigation, responsive transitions and dismissal.

Workflow components remain mounted when hidden. View progress reopens Session;
an import that reaches a confirmation while hidden reopens Session before showing
the modal confirmation. Escape cancels only the topmost confirmation. Startup
recovery offers use View recovery without automatically opening or focusing Settings.

Confirm before clearing applies immediately. Successful writes report Saved in
this browser; failure retains the visit's value and offers Retry saving preferences
using current choices. Reset continues to require confirmation independently of
the CLEAR preference. ZIP, input, recovery and destructive explanations retain
their existing functional controls for the subsequent presentation slices.

## Evidence

Production-browser coverage in `settings-panel.spec.ts` exercises navigation,
page-local group memory, preference persistence/failure/retry, actual capture and
playback while navigating, focus containment/return, 1024/1023px transitions,
320px fit, the existing 640px zoom-equivalent viewport and reduced motion. A delayed
real export completes after group changes and dismissal. `session-import.spec.ts`
uses a delayed file read to verify hidden-import confirmation and cancellation of
the import operation while live playback continues.

Existing workflow tests now enter the appropriate Settings group, distinguish
the named Audio status from preference/transfer feedback, and use explicit recovery
entry after reload. Existing responsive and confirmation screenshots remain test
artifacts. These assertions observe visible controls and engine acknowledgements;
they do not claim physical audio acceptance.

Local verification: the complete 149-test browser suite passed before review
corrections; all 60 affected browser cases passed afterwards, including two added
persistence regressions for interruption and a failed input-preference write.
All 87 Vitest cases, scaffold checks, TypeScript, ESLint, formatting with the
checkout's line endings, Rust formatting/Clippy and the production WASM/web builds
passed. Native Rust tests could not link locally because `link.exe` is absent;
the existing Linux CI job supplies that check. Desktop and narrow screenshots
were inspected; narrow modal captures use the viewport rather than the background
page's full height.

Manual verification: deferred to #19. Existing CLEAR/reset, input and session
acceptance cases remain in [the shared catalog](manual-validation.md); no new
hardware-only behavior is introduced. #64–#67 own the remaining workflow copy
and presentation refinements.
