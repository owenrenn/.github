// Pure decision layer for the Card Shark exit valve (#469 Plan B).
//
// Every decision this workflow makes lives here so it can be tested without a
// board, a token, or an event. The workflow does I/O and nothing else.
//
// This repo is PUBLIC and the fleet canon (the operations repo's labels.json,
// fleet.json) is PRIVATE, so nothing here may depend on reading canon. Where a
// rule must be duplicated rather than derived, it is duplicated in the WIDER
// direction and the divergence is named in a comment.

const PM_PREFIX = "pm:";
const AUDIENCES = ["pm-surface", "agent-zone"];

/** The valve's membership test. Wider than reconcile.js's derived set, on purpose. */
const isPmLabel = (name) => typeof name === "string" && name.startsWith(PM_PREFIX);

/**
 * Decide what an issues event implies for board membership.
 *
 * `currentLabels` MUST be a fresh read of the issue's labels, not the event
 * payload's. The payload describes the moment the event fired; by the time this
 * runs, a second label operation may have landed. The unlabeled path is the one
 * that turns on this -- see the two-pm-labels test.
 */
function decideAction({ eventAction, audience, eventLabel, currentLabels }) {
  if (!AUDIENCES.includes(audience)) {
    throw new Error(`unknown audience ${JSON.stringify(audience)} — expected one of ${AUDIENCES.join(", ")}`);
  }
  const labels = currentLabels || [];
  const pmRemaining = labels.filter(isPmLabel);
  const isAgentZone = audience === "agent-zone";
  const noop = (reason) => ({ kind: "noop", applyProductLabel: false, reason });

  if (eventAction === "opened") {
    if (isAgentZone) return noop("agent-zone issues reach the board only by explicit escalation");
    // pm-surface: every issue auto-flows (AGENTS.md), AND pm:* <=> on-board
    // (spec 3.1). Backfilling the label the templates already default is the
    // only option that keeps both true without a foundational-doc edit.
    return {
      kind: "add",
      applyProductLabel: false,
      ...(pmRemaining.length === 0 ? { backfillLabel: "pm:awareness" } : {}),
      reason: "pm-surface issue opened",
    };
  }

  if (eventAction === "labeled") {
    if (!isPmLabel(eventLabel)) return noop(`${eventLabel} is not a pm:* label`);
    return {
      kind: "add",
      applyProductLabel: isAgentZone,
      reason: `${eventLabel} applied`,
    };
  }

  if (eventAction === "unlabeled") {
    if (!isPmLabel(eventLabel)) return noop(`${eventLabel} is not a pm:* label`);
    if (pmRemaining.length > 0) {
      return noop(`still carries ${pmRemaining.join(", ")}`);
    }
    return { kind: "remove", applyProductLabel: false, reason: `last pm:* label (${eventLabel}) removed` };
  }

  return noop(`unhandled event action ${eventAction}`);
}

/** Non-empty date field values on a board item, as {field, date}. */
function datesOf(boardNode) {
  const nodes = boardNode?.fieldValues?.nodes || [];
  return nodes
    .filter((v) => v && v.date && v.field && v.field.name)
    .map((v) => ({ field: v.field.name, date: v.date }));
}

/**
 * Read the whole board, paging until the cursor is exhausted.
 *
 * WHY this is a module rather than a loop inside the workflow's github-script
 * step: it used to be that loop, and it shipped #490 -- a defect that
 * survived design, implementation and review because nothing could
 * execute it. tests.yml already argues the general form of this: the code runs
 * from this repo, so the suite has to be able to reach it.
 *
 * TWO THINGS THE INLINE VERSION GOT WRONG, and they compound:
 *
 *   1. `declared` was reassigned on EVERY page while `nodes` accumulated across
 *      all of them, so it ended up holding the last page's totalCount. A board
 *      that changed size mid-read then disagreed with itself by construction.
 *      It is pinned to page 0 here -- "what the board said it held when this
 *      read began" is the only reading that stays comparable to a total
 *      collected across the whole read. (The project-id guard below already
 *      reasoned this way -- "checked on the first page only" -- and the same
 *      reasoning simply was not carried across to the count.)
 *
 *   2. A received-vs-declared mismatch was terminal. It conflates two states
 *      that need opposite handling: a TRUNCATED read (pages missing -- absence
 *      is unknowable, must fail) and a CONCURRENTLY MUTATED one (the board was
 *      written while we paged -- transient, resolves on a re-read). Only the
 *      first is unrecoverable, so a mismatch is retried and reported unreadable
 *      only if it persists.
 *
 * ⚠️ The retry does NOT weaken the guard, and must not be read as doing so. A
 * read that never reconciles still reports `inconsistent`, because absence
 * inferred from a partial board is the silent no-op the whole valve exists to
 * prevent. What the retry removes is a FALSE positive, not the true one.
 *
 * WHY this race is ordinary rather than exotic: the valve fires on every label
 * event across every fleet repo, and batch de-escalation -- a demotion pass, a
 * parking sweep -- is a designed-for operation (#469 §4). Five
 * simultaneous removals is what triggered #490 in the first place.
 *
 * ⚠️ A repo-agnostic concurrency group is NOT the alternative fix. Actions
 * concurrency groups are scoped per repository, so runs in two different fleet
 * repos cannot be serialized against each other by any group name. The existing
 * per-issue group is still correct for what it covers (the labeled/unlabeled
 * pair on ONE issue) and is deliberately left alone.
 *
 * `runQuery(cursor)` returns the raw GraphQL response; `sleep` and the bounds
 * are injected so the suite can exercise the retry without waiting on it.
 */
async function readBoard({
  runQuery,
  projectId,
  maxPages = 20,
  maxAttempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoffMs = 2000,
}) {
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let cursor = null;
    let nodes = [];
    let declared = null;
    let page = 0;
    let truncated = false;

    do {
      const res = await runQuery(cursor);
      const project = res?.user?.projectV2;
      // Null rather than an error is how a renamed owner or a deleted project
      // arrives. Retrying cannot help and would only delay the report.
      if (!project) return { status: "no-project", attempts: attempt };
      if (page === 0) {
        // Resolved by NUMBER in the query, so this compares two INDEPENDENT
        // hardcoded references to the board rather than a value against itself.
        // Also not retryable -- a wrong board stays wrong.
        if (project.id !== projectId) {
          return { status: "wrong-project", got: project.id, attempts: attempt };
        }
        declared = project.items.totalCount;
      }

      const items = project.items;
      nodes = nodes.concat(items.nodes || []);
      cursor = items.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
      page++;

      // Gated on `cursor` deliberately: without it a read that legitimately
      // COMPLETES on the cap page fails identically to a cursor that stopped
      // advancing, and telling those apart is the entire job of this guard.
      if (cursor && page >= maxPages) {
        truncated = true;
        break;
      }
    } while (cursor);

    // A stuck cursor is not transient -- a re-read loops the same way -- so this
    // returns rather than falling through to the retry below.
    if (truncated) return { status: "truncated", attempts: attempt, received: nodes.length, declared };

    if (nodes.length === declared) {
      return { status: "ok", nodes, received: nodes.length, declared, attempts: attempt };
    }

    last = { received: nodes.length, declared };
    if (attempt < maxAttempts) await sleep(backoffMs);
  }

  return { status: "inconsistent", ...last, attempts: maxAttempts };
}

/**
 * Find the board item for an issue, FROM THE PROJECT SIDE.
 *
 * The obvious implementation -- read issue.projectItems and delete the match --
 * cannot be used: projectItems does not traverse an org-owned repo's issue to a
 * user-owned project, and it fails by returning an EMPTY LIST rather than an
 * error. It would run to completion, delete nothing, and exit 0 in most of the
 * fleet's repos. Spec 2.
 *
 * Which means absence is only meaningful if the read was complete, so the
 * received-vs-declared guard runs BEFORE any matching. A short read reports
 * `unreadable`; it must never be reported as a difference. (Same rule, and the
 * same reason, as guardBoardRead in the operations repo's escalation reconciler.)
 */
function resolveRemoval({ boardNodes, received, declared, owner, repo, number }) {
  if (received !== declared) {
    return { status: "unreadable", received, declared };
  }
  // Leans on GraphQL's schema guarantees: Issue.repository, Repository.owner and
  // RepositoryOwner.login are all non-null, so a node that IS an Issue always has
  // these. A malformed nested shape would fall through to `absent` -- silent, and
  // on the success path -- so if Task 3's query selection ever narrows, this
  // assumption is what breaks first.
  const hit = (boardNodes || []).find((n) => {
    const c = n && n.content;
    if (!c || c.__typename !== "Issue") return false;
    return (
      c.number === number &&
      c.repository?.name === repo &&
      c.repository?.owner?.login === owner
    );
  });
  if (!hit) return { status: "absent" };
  return { status: "found", itemId: hit.id, dates: datesOf(hit) };
}

/**
 * The comment posted immediately BEFORE deleting an item that carries dates.
 *
 * Engagement, Track and Priority all derive from labels and the autofill sweep
 * restores them on re-escalation. Deferred until and Due date do not -- they are
 * hand-set, and deleting the item is the only place they can be lost. Several
 * dozen items carry a deferral as of 2026-08-13 (the parking pass put them
 * there), so this is no longer the negligible loss the original spec priced.
 */
function preservationComment({ dates, itemId }) {
  const rows = dates.map((d) => `| ${d.field} | ${d.date} |`).join("\n");
  return [
    "🔖 **Card Shark field values preserved before de-escalation**",
    "",
    "The last `pm:*` label was removed, so this issue left Card Shark and its board",
    "item was deleted. These hand-set values do not derive from labels and would",
    "otherwise be lost — re-apply them if this is ever re-escalated:",
    "",
    "| Field | Value |",
    "|---|---|",
    rows,
    "",
    `<sub>Deleted item \`${itemId}\`. Automated by \`card-shark-sync.yml\`.</sub>`,
  ].join("\n");
}

module.exports = { isPmLabel, decideAction, datesOf, readBoard, resolveRemoval, preservationComment };
