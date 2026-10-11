# Settings interaction contract

Status: accepted by the owner on 2026-10-11, without amendments, against reviewed
revision [88c4889](https://github.com/ty-jt-agent/LoopBeats/blob/88c4889094cb36e259dfbaf3234196b289cbf9f5/docs/specs/settings-interaction-contract-62.md)
in PR #68. The owner replied: “Accept the contract as written.”
[The acceptance record in #62](https://github.com/ty-jt-agent/LoopBeats/issues/62#issuecomment-6105451861)
satisfies the design gate and permits #63 to proceed. Parent #61 is unchanged.

This contract resolves the eight questions in
[the design interview](settings-ui-design.md). It changes presentation only;
[ADR-0002](../adr/0002-portable-sessions-and-recovery.md), existing audio-client
eligibility, recovery ownership and deletion barriers remain authoritative.

## 1. Presentation and dismissal

Use a right-hand, nonmodal Settings panel at viewport widths of at least
1024 CSS pixels. Reserve space for a panel up to 28rem wide instead of covering
track controls. Below 1024 CSS pixels, use a modal panel occupying the viewport,
with an independently scrolling body and visible heading and Close button.
Opening either presentation leaves audio running.

The desktop panel keeps performance controls accessible. The narrow modal avoids
cramped adjacent controls, at the cost of requiring Close before interacting
with tracks. A centered modal would obstruct desktop performance controls; the
existing inline disclosure makes the longer workflows harder to scan. The owner
accepted these tradeoffs in the review recorded above.

The Settings trigger opens the panel, or closes it when already open. Close and
Escape dismiss it; clicking outside does not. Viewport changes preserve the
selected group, entered values, progress and confirmations. Moving across the
breakpoint changes focus containment without restarting any workflow. No panel
animation is required, including with reduced motion enabled.

Closing or changing groups never aborts a transfer, dismisses a recovery offer,
stops audio or discards edits already applied. Keep operation owners alive while
their views are hidden. While a transfer runs with Settings closed, show a compact
status and View progress button beside the Settings trigger; it reopens Session.
Completion or failure remains available there until acknowledged or the next
operation starts. A nested confirmation must be decided before Settings can
close; its modal layer makes the Settings Close control and trigger inert.

## 2. Navigation and focus

Use a named Settings region on desktop and a named modal dialog on narrow
screens. On opening, focus the selected group tab. Session is the initial group
on each page load. Remember the last selected group only for this page's later
openings, without persisting navigation in browser settings. View recovery and
View progress explicitly select Session.

Use Session, Audio and Preferences tabs with an associated tab panel. Left/Right
and Home/End move and activate tabs, with one tab in the Tab sequence. Tab enters
the selected group's controls in visual order. Hidden panels retain workflow
state but are absent from the focus order and accessibility tree. Use a horizontal
tab row on both layouts, with no horizontal scrolling at 320 CSS pixels.

Desktop has no focus trap; Escape closes Settings only when focus is within it.
The narrow dialog contains keyboard focus and makes background controls inert.
Closing returns focus to the opener if still usable, otherwise to Settings.
Responsive transitions preserve the focused control when possible; when entering
modal mode with focus outside, focus the selected tab.

Confirmation dialogs have their own name and focus containment. Focus Cancel
first; Escape means Cancel for the topmost confirmation and does not also close
Settings. Outside clicks do not dismiss confirmations. After a decision, return
focus to its initiating control if usable, otherwise the selected group tab.
An operation's Cancel button explicitly cancels only while the existing client
allows it; committing import/recovery shows Finishing load and cannot be cancelled.

## 3. Session ZIP actions

Place Save ZIP and Load ZIP first in Session, followed by Recovery and a separate
Remove recordings area. Use this helper copy:

- Save ZIP: Download a portable session with all completed track recordings and
  session settings. An unfinished recording is not included.
- Load ZIP: Load a saved session. If current recordings exist, you will confirm
  before replacing them. Imported recordings start stopped.

Availability follows acknowledged client state, never a separate UI transport.
The following conditions combine; any blocking condition disables the action.
Show its reason beside the actions, with priority startup, session operation,
input switching, then capture. Retain the action labels when disabled.

| Condition | Save ZIP | Load ZIP | Reason when blocked |
| --- | --- | --- | --- |
| Audio not ready, including starting or failed | Disabled | Disabled | Start audio to use session files; show startup failure separately if present. |
| Ready, stopped or playing | Enabled | Enabled | None; playback need not stop first. |
| Initial recording in progress | Enabled, completed recordings only | Disabled | Finish or stop recording before loading a session. |
| Overdub in progress | Disabled | Disabled | Finish or stop overdubbing before using session files. |
| Input switch pending | Disabled | Disabled | Wait for the input change to finish. |
| Another manual session operation pending | Disabled | Disabled | Wait for the current session operation or cancel it when available. |

Display labelled progress, explicit cancellation, and persistent result/error
feedback. Successful export says ZIP download started; browser download initiation
does not prove a file was written to disk. Import validates before replacement.
If conversion/downgrading is required, explain the source and target rates and
the conversion consequence, then obtain consent before converting. Afterwards,
if the current session contains recordings, confirm replacement separately.
An empty workspace does not require replacement confirmation. Cancellation,
rejection and failure retain the
current session. Successful load restores all supported session data with tracks
Stopped or Empty, transport reset and monitoring off; it does not restore device
permissions or select an archived input device.

## 4. Recovery

Show one compact Recovery status in Session, with Details as an inline disclosure.
Details contains the explanation, last successful saved time when available,
partial-work notice, and relevant actions. Do not hide actionable errors behind
Details. Times are informational and never promise a maximum data-loss interval.
Map existing client status/ownership/offer/error to presentation; introduce no
new recovery policy or persisted state machine.

| State | Compact message and actions |
| --- | --- |
| Checking storage | Checking recovery; no destructive action. |
| Owned, no checkpoint yet | Recovery ready; show saving status when work is pending. |
| Saving | Saving recovery; retain the previous successful saved time. |
| Saved | Recovery saved, with last successful time; Details explains browser-local storage. |
| Pending work | Recovery changes pending; do not call them saved. |
| Valid startup offer | Saved workspace available; Recover, Later and Discard saved workspace. |
| Invalid saved record | Saved workspace could not be read; visible explanation and owner-only Discard saved workspace. No Recover. |
| Save failed | Recovery could not be saved; error, retained last successful time and Retry saving. |
| Storage unavailable | Recovery unavailable; explain the failure and recommend Save ZIP when eligible. Explain that reloading rechecks availability; do not promise a working retry through an unavailable controller. |
| Initialization/storage read failed | Recovery could not be checked; show the error and explain that current recovery saving is paused. Recommend Save ZIP when eligible, then reload to check again. Do not expose saving/ownership retry as a read retry. |
| Other tab owns storage | Recovery paused: another tab owns recovery; Retry ownership. Recover/discard/save retry are unavailable. |

When an offer is discovered, show a compact notice beside Settings with View
recovery. Do not automatically focus, open a modal, start audio or replace tracks.
Later hides the startup notice but leaves the offer accessible through Session.
Closing Settings does not mean Later. An unresolved old workspace remains kept,
and recovery saving for the current workspace remains paused until Recover or
Discard resolves it; state this beside the offer even after Later.

Recover requires ownership and the same readiness/capture/switch/session-operation
eligibility as Load ZIP. It follows the existing validation, conversion and
replacement safeguards. For partial checkpoints, disclose before replacement
that an unfinished recording/overdub may be restored only through the saved
prefix; no unsaved remainder is promised. Details after restoration repeats the
partial-work notice. Manual Save ZIP remains completed-recordings-only.

Discard saved workspace requires ownership, but does not require audio startup.
Always confirm with Cancel first: this removes the browser recovery copy, not
the current live recordings. Subsequent recovery saving can create a new copy;
discard does not disable recovery permanently. A failed discard retains the offer
and current recordings, shows the error and allows retrying the discard through
confirmation. Retry saving is reserved for saving failure and does not substitute
for retrying a failed destructive action. Ownership retry never promises takeover
from an active owning tab.

Initialization/read failures can share an existing generic error string with save
failures. Distinguish them using existing offer/ownership/status and initialization
outcome at the client presentation seam; if that outcome is not exposed, retain
generic truthful failure copy and the Save ZIP/reload guidance, without promising
an unsupported retry. This does not change storage initialization semantics.

Recovery details must also explain the deletion gap: deletion-first actions such
as CLEAR, replacement and global STOP during initial capture can remove the owned
current checkpoint. Surviving recordings may have no recovery copy until the next
successful save. Keep this warning alongside relevant destructive explanations;
do not report surviving work as already protected by the deleted checkpoint.

## 5. Audio input

Show Input device in Audio even before startup, with a disabled selector and
Start audio to choose an input. Saved preferences are restored when audio starts.
Use the existing Start audio control; do not add a second lifecycle owner.

When ready, show System default plus enumerated inputs and the acknowledged
selection. If a preferred input is unavailable, explain that the available
fallback is in use without claiming the missing preference was selected.
Missing labels use the existing safe fallback names. If there are no available
inputs or permission/startup failed, show the actual failure and applicable
existing startup retry, rather than an apparently working empty selector.

Disable selection while switching, transport is running, or any track is
Recording, Playing or Overdubbing. Show Changing input while pending, otherwise
Stop playback and capture before changing input. Explain that completed recordings
are retained and the shared transport resets. On success, display the acknowledged
device; on failure, display the actual client selection/state and error, with retry
only when existing eligibility permits. Do not optimistically present a requested
device as active or bypass client command exclusions.

## 6. Preferences

Keep Confirm before clearing in Preferences, available before audio starts.
Changes apply immediately to subsequent CLEAR actions and persist through the
existing browser settings store. Use no Apply/Cancel model. Closing Settings does
not roll back the checkbox. This preference never suppresses Reset, replacement,
conversion or saved-workspace discard confirmations.

Report Saved in this browser only after a successful write. If persistence fails,
retain the new value for this visit and show Applied for this visit; could not
save in this browser with Retry saving preferences. Retry writes current
preferences through the same store; it does not restore stale values. On reload,
the last successfully persisted values or existing defaults apply. Feedback
must not claim unavailable storage succeeded, add a settings schema or persist
panel navigation. Input preference persistence follows acknowledged selection.

## 7. Remove recordings

Place Reset session under a visually separated Remove recordings heading at the
end of Session; do not put it alongside Save ZIP and Load ZIP. Keep it unavailable
before ready, during input switching, and when there is no recording/shared cycle
to reset, following the existing client predicates. Do not invent a STOP-first
restriction: existing reset can remove active work after confirmation.

Always confirm Reset session, with Cancel first. Explain removal of current track
recordings, shared cycle and unfinished work, stopped/reset transport and monitoring
off. Modes, gains, mute and saved preferences remain as defined by the existing
reset contract. Explain removal of the current workspace's owned recovery copy
when that deletion barrier applies; an unresolved previous-workspace offer or
another tab's copy is retained under existing ownership rules.

Deletion must complete before the live destructive action when required. Failure
leaves live recordings unchanged and shows a visible error; retry Reset requires
confirmation again. Existing session revision checks invalidate stale imports
when reset changes the workspace; the panel must not bypass those checks. Recovery
discard stays inside Recovery and explicitly describes its backup-only scope.
Per-track CLEAR stays on the track; its existing preference and deletion safeguards
remain intact. Settings dismissal never invokes any destructive action.

## 8. Observable production-browser acceptance

Use the agreed existing production-browser workflows, actual ZIP operations and
existing recovery fixtures. These are downstream acceptance scenarios, not tests
claimed to pass in this documentation slice. Browser audio/engine acknowledgements
remain the observation seam; no hardware checklist gates these presentation tickets.

| ID | Observable scenario |
| --- | --- |
| S01 | Open/close desktop Settings while playing; audio/transport continue and track controls remain usable. |
| S02 | At 1024px use nonmodal side panel; at 1023px use modal full viewport; resizing preserves group, focus where possible and transfer progress. |
| S03 | At 320x568px and at 200% desktop zoom with a narrow CSS viewport, all controls/confirmations are reachable without horizontal overflow; scrolling leaves Close reachable. |
| S04 | Keyboard entry, tabs, arrows/Home/End, desktop Escape, narrow focus containment/inert background and opener focus return match sections 1–2. |
| S05 | First opening selects Session; reopen remembers group for this page; reload defaults to Session; View recovery/progress selects Session. |
| S06 | Reduced motion has no required animation; visible focus and status remain usable. |
| S07 | Exercise every row and combined blockers of the ZIP matrix, including playback eligibility and completed-only export during initial capture. |
| S08 | Start a ZIP transfer, change groups and close Settings; it continues, progress remains accessible and result/error can be reopened. Explicit cancellation preserves current tracks. |
| S09 | Load a different-rate archive: conversion consent precedes conversion and replacement consent when current recordings exist; an empty workspace skips replacement consent. Cancel either retains current data. Successful load restores all supported data stopped. |
| S10 | During nested confirmation, Escape cancels only it; outside click cannot dismiss it; focus returns sensibly and no underlying panel dismissal occurs. |
| S11 | Startup offer does not steal focus/start audio; Later hides notice, Session can reopen it, and current autosaving remains paused until the offer is resolved. |
| S12 | Exercise checking, pending, saving, saved and failure recovery statuses with truthful saved times and relevant retries. |
| S13 | Partial recovery discloses the saved prefix before replacement and after restoration; unfinished manual export is still excluded. |
| S14 | Invalid records, unavailable storage, initialization/read failure and other-tab ownership expose truthful explanations and only supported actions; an owner-held read failure never offers a retry that cannot proceed. |
| S15 | Discard confirmation/cancel/failure/success affects only recovery copy; failure retains it and live tracks; future autosaving remains possible. |
| S16 | Before startup, Audio explains disabled input; ready/fallback/no devices/permission failure/switch pending/failure display acknowledged state. Running transport/capture blocks selection. |
| S17 | Toggle Confirm before clearing before startup; it applies immediately, survives close/reopen and successful reload persistence, but never suppresses other confirmations. |
| S18 | Force preference write failure; current visit keeps the new value, feedback reports failure, retry writes current values, and reload uses last successful values. |
| S19 | Reset active and stopped work after confirmation; verify deletion barrier failure retains live data, successful reset consequences and preserved modes/gains/mute/preferences. |
| S20 | Reset with unresolved old offer or other-tab ownership preserves that copy; stale pending import cannot overwrite a reset workspace; dismissing Settings causes no deletion. CLEAR/replacement/global STOP deletion-gap explanations do not claim surviving work is saved before a new checkpoint succeeds. |

## Delivery and review gate

#63 implements presentation, navigation, focus and Preferences (S01–S06, S17–S18).
#64 implements Audio (S16); #65 ZIP flows (S07–S10); #66 Recovery (S11–S15);
#67 destructive presentation (S19–S20). Shared scenarios also apply to each
workflow's controls. Those four workflow slices remain independently blocked
only by #63. This contract does not change their dependency graph.

Owner review is complete for the concrete choices above, including the
desktop/nonmodal versus narrow/modal tradeoff. The linked acceptance record
identifies the reviewed revision; #62's owner-review prerequisite for #63 is
satisfied. Documentation merge and engineering approval alone did not satisfy
that requirement. Future changes to these decisions require a new owner review.
No new domain vocabulary or architectural decision is required for these
reversible presentation choices.
