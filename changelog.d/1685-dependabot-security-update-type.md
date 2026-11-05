---
type: fixed
---
The Dependabot merge now merges security updates. Dependabot leaves `update-type` out of a security update's metadata, so every one was refused as "not patch or minor". The step is now read from the commit's subject line for a one-dependency update, and only when the subject names the block's own dependency and version with three-part versions (#1685).
