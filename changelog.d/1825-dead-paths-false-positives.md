---
type: fixed
---
The dead-path ratchet no longer reads a link written inside inline code as a link, and resolves a bare path in a comment against each folder above the file as well as the repo root, so an example of link syntax or a path one skill folder owns is no longer reported dead (#1825).
