---
type: fixed
---
Release ordering and the security check's patched-version comparison ignore `+build` metadata, so a version like `0.9.12+spec-1.1.0` reads as 0.9.12 and not as a prerelease of it.
