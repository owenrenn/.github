---
type: fixed
---
The Dependabot merge now merges security updates. Dependabot leaves `update-type` out of a security update's metadata, so every one was refused as "not patch or minor". A one-dependency update with no `update-type` now takes its step from the `from A to B` versions its commit message writes. Every such pair must name the block's own dependency and version and agree on the old one, and both versions must be `x.y.z` with no pre-release. A refusal now says why the message could not be read (#1685).
