# CLAUDE.md — owenrenn/.github (shim)

Canonical instructions live in [`AGENTS.md`](AGENTS.md). Claude Code imports them below.

---

@AGENTS.md

## Session memory

Claude Code additionally maintains `MEMORY.md` at `~/.claude/projects/<repo-path>/memory/`
(per-machine, **not** repo-tracked). Keep it a thin pointer index under the budget. Canon for
that convention is `memory-management-standard.md` in the engineering knowledge base — named
by role rather than repository, per this repo's [`AGENTS.md`](AGENTS.md) content policy.

⚠️ **Do not "fix" this line by pasting the fleet template's version of it.** That template
carries the slug as a URL into a **private** repository, and this repo is public — publishing
it discloses the existence of a repo GitHub deliberately returns `404` for to anonymous
callers, which is the one thing that policy exists to prevent. The bare slug is the deliberate
form: it satisfies the fleet conformance check, which tests for the document slug and not for
a link, while disclosing nothing. A reader with access can find the document from the slug.
