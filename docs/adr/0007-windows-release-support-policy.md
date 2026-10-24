# Scope the first Windows release to supported Windows 11 x64

Status: accepted, 2026-10-24.

The first Windows release targets Windows 11 Home and Pro versions still under Microsoft support at release time, on x64. Windows 10 is outside the supported and tested scope even if the application runs there; do not add a version gate solely to prevent that. Before release, publish the exact minimum Windows version/build and list the Windows versions/builds actually tested, using Microsoft lifecycle information rechecked at release time. ARM64 is a separate scope decision requiring its own build and hardware validation. Runtime audio-device and driver capability checks remain necessary on supported Windows versions; the OS label alone does not guarantee low-period shared-mode support. This is an initial release policy, not an open-ended promise to support every Windows 11 version or edition.
