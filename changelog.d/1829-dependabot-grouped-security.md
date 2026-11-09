---
type: fixed
---
The Dependabot merge now merges a grouped security update. Each member with no `update-type` takes its step from its own ``Updates `x` from A to B`` line, so a group of patches and minors merges and one major among them refuses it. A member with no readable line, or a line naming a dependency the update does not list, refuses it. An `Updates` line that cannot be read now refuses any update, lone or grouped, since it could hold another copy's version (#1829).
