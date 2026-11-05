---
type: fixed
---
The Dependabot merge now merges security updates. Dependabot leaves `update-type` out of a security update's metadata, so every one was refused as "not patch or minor". A one-dependency update with no `update-type` now takes its step from the versions its commit message names, only when the subject and the body's `Bumps` line name the block's own dependency and version and agree on the old one, and both versions are plain `x.y.z`. A refusal now says why the message could not be read (#1685).
