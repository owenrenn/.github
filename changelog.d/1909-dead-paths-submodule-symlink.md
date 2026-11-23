---
type: fixed
---
The dead-path ratchet no longer stops with exit 2 in a repo with a submodule or a tracked symlink: a path under one is skipped, and the summary counts how many were (#1909).
