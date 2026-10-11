# Settings UI design interview

Status: interview complete; the owner accepted the interaction contract on
2026-10-11. This document retains the interview context.

The eight questions below are resolved in the accepted
[Settings interaction contract for #62](settings-interaction-contract-62.md).
Its linked owner-acceptance record satisfies the design gate for implementation.

## Problem

The current Settings disclosure mixes session file operations, lengthy recovery
explanations, audio input selection, preferences and destructive reset controls.
Common actions are difficult to scan and unavailable controls need clearer reasons.

## Agreed direction

- Session: Save ZIP, Load ZIP and a compact recovery status.
- Audio: input device selection and clear explanations when switching is unavailable.
- Preferences: confirmation before clearing tracks.
- Separate Reset session into a destructive-actions area.
- Reveal detailed recovery explanations when needed.

These are presentation decisions. Existing session import/export and recovery
contracts remain the baseline, including conversion consent, replacement
confirmation, completed-only manual export and stopped restoration.

## Resolved interview questions

The accepted presentation is a nonmodal side panel on desktop and a modal
full-screen panel on narrow screens. Opening Settings leaves audio running.
The interaction contract records the evaluated centered-dialog and inline
disclosure alternatives and the accepted tradeoffs.

1. Settings presentation on desktop and narrow screens.
2. Navigation between groups and default opening section.
3. Save ZIP / Load ZIP labels, placement and action availability.
4. Recovery status, startup offer, errors and access to details.
5. Audio input availability and visibility before audio starts.
6. Preference application and persistence feedback.
7. Reset placement, confirmation and recovery-deletion explanation.
8. Keyboard/focus behavior, dismissal and operations in progress.

No new domain terms or architectural decision are needed. Use the existing root
glossary and ADR-0002; the accepted interaction contract governs implementation.
Further amendments require owner review before implementation.
