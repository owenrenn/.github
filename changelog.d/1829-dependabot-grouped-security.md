---
type: fixed
---
The Dependabot merge now merges a grouped security update. Each member with no `update-type` takes its step from its own ``Updates `x` from A to B`` line, so a group of patches and minors merges and one major among them refuses it. A member with no readable line, a line naming a dependency the group does not list, or an `Updates` line that cannot be read refuses the group (#1829).
