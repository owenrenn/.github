// Pure decision layer for the Card Shark exit valve (#469 Plan B).
//
// Every decision this workflow makes lives here so it can be tested without a
// board, a token, or an event. The workflow does I/O and nothing else.
//
// This repo is PUBLIC and the fleet canon (the operations repo's labels.json,
// fleet.json) is PRIVATE, so nothing here may depend on reading canon. Where a
// rule must be duplicated rather than derived, it is duplicated in the WIDER
// direction and the divergence is named in a comment.

const { PRIORITY_LABELS } = require("./fields.js");

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

  // BOTH label paths decide from `pmRemaining` -- the issue's CURRENT labels --
  // and never from `eventLabel`. #563.
  //
  // WHY, and it is not a style preference: label ops on one issue are serialized
  // by a concurrency group (see the workflow), and `cancel-in-progress: false`
  // does NOT mean every queued run executes. GitHub keeps only the NEWEST pending
  // run in a group and cancels the intermediate ones. Creating an issue with
  // several labels fires several `labeled` events inside a few seconds, so the
  // run woken by the pm:* label is routinely one of the cancelled intermediates.
  //
  // Gating on `eventLabel` therefore makes the outcome depend on WHICH event won
  // a race -- and the survivor is usually woken by an unrelated domain or
  // priority label, decides "not a pm:* label", and the escalation is silently
  // lost. Measured live: an issue created with four labels including pm:awareness
  // produced five runs (two survived, three cancelled) and never reached the
  // board.
  //
  // Deciding from state makes the race irrelevant: whichever run survives reads
  // the same labels and reaches the same, correct decision. The event's only
  // remaining job is to say which DIRECTION is worth checking, which is a cheap
  // optimisation rather than an input to correctness.
  //
  // ⚠️ Same shape as the removal path's project-side resolution below: resolve
  // from durable state, never from what the event happened to carry.
  if (eventAction === "labeled") {
    if (pmRemaining.length === 0) return noop(`no pm:* label present (woken by ${eventLabel})`);
    return {
      kind: "add",
      applyProductLabel: isAgentZone,
      reason: `carries ${pmRemaining.join(", ")}`,
    };
  }

  if (eventAction === "unlabeled") {
    if (pmRemaining.length > 0) {
      return noop(`still carries ${pmRemaining.join(", ")}`);
    }
    // Reached for a non-pm label removal too, on an issue that carries no pm:*.
    // That is the point: if a pm:* removal's run was the cancelled intermediate,
    // this is the only event left that can still retire the board item. The cost
    // is a board read that usually resolves `absent` and does nothing -- measured
    // at roughly three extra reads per week in the busiest repo, against a fix
    // for an item that would otherwise be stranded on the board indefinitely.
    return { kind: "remove", applyProductLabel: false, reason: `no pm:* label remains (woken by ${eventLabel})` };
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
 *
 * ⚠️ THERE IS A SECOND IMPLEMENTATION OF THIS READ, and it is not in this repo.
 * The operations repo's escalation reconciler pages the same board and applies
 * the same received-vs-declared rule (its `guardBoardRead`, cited again in
 * resolveRemoval below). It is a deliberate port, not shared code -- see that
 * repo's #494 for why, and for the divergences that are intentional.
 *
 * WHY THIS POINTER IS HERE, on the paging function rather than only further
 * down: the two copies have drifted apart twice (#490 fixed the defect here,
 * #491 found it still live in the port), and both times the cause was simply
 * not knowing the other copy existed while fixing this one. Both defects were
 * in the paging and its guard -- this function -- so this docblock is where the
 * next person needs to be told. Fixing anything below WITHOUT checking the port
 * is how #491 happened.
 */
async function readBoard({
  runQuery,
  projectId,
  maxPages = 20,
  maxAttempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoffMs = 2000,
  random = Math.random,
}) {
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let cursor = null;
    let nodes = [];
    let declared = null;
    let page = 0;
    let retry = null; // set when this attempt ended in something a re-read may fix

    try {
      do {
        const res = await runQuery(cursor);
        const project = res?.user?.projectV2;
        if (!project) {
          // Two different faults wearing one shape, and only the first is
          // terminal. On page 0 the project genuinely does not resolve -- a
          // renamed owner or a deleted board, which a re-read cannot fix. On a
          // LATER page it vanished mid-read, which is transient and must not be
          // reported as "the project did not resolve" -- that sends the reader
          // to a cause that is not the one they have.
          if (page === 0) return { status: "no-project", attempts: attempt };
          retry = "project vanished mid-read";
          break;
        }
        if (page === 0) {
          // Resolved by NUMBER in the query, so this compares two INDEPENDENT
          // hardcoded references to the board rather than a value against itself.
          // Not retryable -- a wrong board stays wrong.
          if (project.id !== projectId) {
            return { status: "wrong-project", got: project.id, attempts: attempt };
          }
          declared = project.items?.totalCount;
          // A missing totalCount is a broken RESPONSE SHAPE, not a race. Left to
          // fall through it fails safe (nothing equals undefined, so `ok` is
          // unreachable) but burns every retry first and then reports
          // "received 0 of undefined" -- which reads as a race and is not one.
          if (typeof declared !== "number") {
            return { status: "malformed", attempts: attempt, detail: "items.totalCount was not a number" };
          }
        }

        const items = project.items;
        nodes = nodes.concat(items.nodes || []);
        cursor = items.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
        page++;

        // Gated on `cursor` deliberately: without it a read that legitimately
        // COMPLETES on the cap page fails identically to a cursor that stopped
        // advancing, and telling those apart is the entire job of this guard.
        //
        // Returns rather than setting `retry`: a stuck cursor loops the same way
        // on a re-read, so retrying only spends two more full board reads to
        // reach the same answer. Returning HERE also makes falling through to
        // the retry structurally impossible rather than merely absent.
        if (cursor && page >= maxPages) {
          return { status: "truncated", attempts: attempt, received: nodes.length, declared };
        }
      } while (cursor);
    } catch (err) {
      // The retry existed for a count mismatch and did not cover a THROW, which
      // is the same transient class and the more likely one: a 502 or a
      // secondary rate limit on page 5 aborted the whole read, went red, and
      // left the label removed with the board item still there. github-script
      // does not retry GraphQL by default (`retries` defaults to 0), so nothing
      // underneath was covering it either.
      retry = `query failed: ${err && err.message ? err.message : err}`;
    }

    if (!retry) {
      if (nodes.length === declared) {
        return { status: "ok", nodes, received: nodes.length, declared, attempts: attempt };
      }
      retry = "count mismatch";
    }

    last = { received: nodes.length, declared, reason: retry };
    if (attempt < maxAttempts) {
      // JITTERED, and that is the point rather than a refinement. The trigger
      // for these retries is CORRELATED -- a batch de-escalation fires many runs
      // at once, they collide on the same board, and they all mismatch within a
      // second of each other. A fixed delay marches every one of them back into
      // the API in lockstep, re-reading the whole board (~7 pages) each time, at
      // exactly the moment the board is busiest. Spreading them is what keeps
      // the fix from amplifying the load it was written to survive.
      await sleep(Math.round(backoffMs * attempt * (0.5 + random())));
    }
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
 * Does this issues event need the sync job at all? The specification of the
 * job-level `if:` in card-shark-sync.yml (#917).
 *
 * The job bills a minute per run and fires on every label operation across the
 * fleet. Reading decideAction above and computeUpdates in fields.js, only these
 * events can change anything:
 *
 *   - `opened` on pm-surface. On agent-zone it is always a noop (decideAction).
 *   - a pm:* label added or removed -- board membership.
 *   - a lane:* or P0-P3 label ADDED. On an issue carrying pm:* that routes
 *     through the add path, which re-mirrors Engagement and Priority -- what
 *     keeps the board's queues live between four-hourly sweeps. Removing one
 *     never clears a field: computeUpdates writes only values that are present.
 *
 * Everything else -- `type:`, area and domain labels, `product:` (including
 * this workflow's OWN product write, which is made with the PAT and so fires
 * another run) -- re-adds an item idempotently and re-mirrors fields that did
 * not move. What skipping them gives up is an incidental retry of an earlier
 * run that failed; the daily reconcile (membership) and the autofill sweep
 * (fields) are the reconcilers for that, as they already are for a cancelled
 * intermediate run (#563).
 *
 * `eventLabel` is the label that WOKE the run. It decides whether to LOOK,
 * never what to conclude: every run that starts still decides from a fresh
 * label read, which is the property #563 restored.
 *
 * ⚠️ The workflow's `if:` is the enforcement and this is its specification.
 * sync.test.js evaluates the shipped expression against this function over an
 * event matrix, so changing one without the other fails the suite. GitHub
 * compares strings case-insensitively and this does not, so the expression is
 * the WIDER of the two -- the safe direction to diverge in.
 */
function shouldSync({ eventAction, audience, eventLabel }) {
  if (eventAction === "opened") return audience === "pm-surface";
  if (eventAction !== "labeled" && eventAction !== "unlabeled") return false;
  if (isPmLabel(eventLabel)) return true;
  if (eventAction !== "labeled" || typeof eventLabel !== "string") return false;
  // lane: by PREFIX, the same rule engagementName uses -- an unknown lane is
  // still honoured there, so it must still wake the run here.
  return eventLabel.startsWith("lane:") || PRIORITY_LABELS.includes(eventLabel);
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

module.exports = { isPmLabel, decideAction, shouldSync, datesOf, readBoard, resolveRemoval, preservationComment };
