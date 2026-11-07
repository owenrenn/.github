// Tests for the release body's Security section (#1693).
//
// The git half runs over a real throwaway repository: which Dependabot commits
// a release contains is a claim about git. GitHub is the one thing stood in
// for: the alert list and PR bodies come from injected readers, so a suite
// never needs the network and the unreadable case can be forced.
//
// Zero dependencies: node --test only.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const sec = require("./security.js");
const { normalize } = require("./config.js");
const { makeRepo, buildRepo, ENV } = require("./fixture.js");
const cli = require("./cli.js");

const ONE = normalize({}).streams;
const TWO = normalize({ changelog: { streams: {
  web: { tagPrefix: "v", paths: ["**"], excludePaths: ["desktop/**"] },
  desktop: { tagPrefix: "desktop-v", paths: ["desktop/**"] },
} } }).streams;

const VITE = { name: "vite", ghsa: "GHSA-aaaa-bbbb-cccc", cve: "CVE-2026-0001", patched: "7.3.7" };
const alerts = (...list) => () => list;
const noBody = () => { throw new Error("no PR body read expected"); };

/** A commit authored as Dependabot, as a squash merge leaves it. */
function botCommit(r, message, files) {
  r.write(files);
  r.git("add", "-A");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: r.root, env: { ...ENV, GIT_AUTHOR_NAME: "dependabot[bot]", GIT_AUTHOR_EMAIL: "bot@example.com" },
  });
  return r.git("rev-parse", "HEAD").trim();
}

function repoWithRelease() {
  return buildRepo((r) => {
    r.commit("init", { "package.json": "{}\n", "src/a.ts": "a\n" });
    r.git("tag", "v1.0.0");
    botCommit(r, "chore(deps): bump vite from 7.3.6 to 7.3.7 (#213)\n\nBumps [vite](https://example.test) from 7.3.6 to 7.3.7.", { "package.json": '{"vite":"7.3.7"}\n' });
    botCommit(r, "chore(deps): bump sharp from 0.35.4 to 0.35.5 (#214)", { "package.json": '{"vite":"7.3.7","sharp":"0.35.5"}\n' });
    r.commit("feat: a thing (#215)", { "src/a.ts": "b\n" });
    r.git("tag", "v1.1.0");
  });
}

// ── parsing ─────────────────────────────────────────────────────────────────

test("bumps are read from a title, a Bumps line, per-package Updates lines and an Actions bump", () => {
  assert.deepEqual(sec.parseBumps("chore(deps): bump vite from 7.3.6 to 7.3.7 (#213)\n\nBumps [vite](x) from 7.3.6 to 7.3.7."),
    [{ name: "vite", from: "7.3.6", to: "7.3.7" }]);
  assert.deepEqual(sec.parseBumps("bump @vitest/mocker and vitest\n\nUpdates `@vitest/mocker` from 4.1.11 to 4.1.12\nUpdates `vitest` from v4.1.11 to v4.1.12"),
    [{ name: "@vitest/mocker", from: "4.1.11", to: "4.1.12" }, { name: "vitest", from: "4.1.11", to: "4.1.12" }]);
  assert.deepEqual(sec.parseBumps("chore(actions): bump some-org/cache-action from 2.9.2 to 2.9.3"),
    [{ name: "some-org/cache-action", from: "2.9.2", to: "2.9.3" }]);
  assert.deepEqual(sec.parseBumps("Merged by hand, all checks green."), []);
});

test("a Dependabot commit is a bot-authored squash or a merge of a dependabot/ branch", () => {
  assert.equal(sec.isDependabotCommit({ author: "dependabot[bot]", subject: "chore(deps): bump x (#1)" }), true);
  assert.equal(sec.isDependabotCommit({ author: "A Person", subject: "Merge pull request #9 from someone/dependabot/npm_and_yarn/x-1.2" }), true);
  assert.equal(sec.isDependabotCommit({ author: "A Person", subject: "chore(deps): bump x from 1 to 2" }), false);
});

test("the range starts after the previous stable tag for a stable release, the previous tag of any kind for a pre-release", () => {
  const streamTags = ["v1.0.0", "v1.1.0-rc.1", "v1.1.0"];
  const reaches = new Set(streamTags);
  assert.equal(sec.previousTag("v1.1.0", { streamTags, prefix: "v", reaches }), "v1.0.0");
  assert.equal(sec.previousTag("v1.1.0-rc.2", { streamTags, prefix: "v", reaches }), "v1.1.0-rc.1");
  assert.equal(sec.previousTag("v1.0.0", { streamTags, prefix: "v", reaches }), null);
  // A tag the release's history does not contain is no boundary.
  assert.equal(sec.previousTag("v1.1.0", { streamTags, prefix: "v", reaches: new Set(["v1.1.0"]) }), null);
});

// ── the section ─────────────────────────────────────────────────────────────

test("a Dependabot PR in range that clears a fixed alert is listed, with its advisory linked", () => {
  const r = repoWithRelease();
  try {
    const out = sec.securityFixes({ root: r.root, ref: "refs/tags/v1.1.0", since: "v1.0.0", stream: ONE.default, readAlerts: alerts(VITE), readBody: noBody });
    assert.equal(out.status, "ok");
    assert.equal(out.commits, 2);
    assert.deepEqual(out.items.map((i) => [i.name, i.from, i.to, i.pr]), [["vite", "7.3.6", "7.3.7", 213]]);
    assert.equal(sec.renderSecurity(out),
      "### Security\n\n- `vite` 7.3.6 → 7.3.7: [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) (CVE-2026-0001) (PR #213)\n");
  } finally { r.cleanup(); }
});

test("a version update clears no advisory, so it is not listed and the section is empty", () => {
  const r = repoWithRelease();
  try {
    // sharp has no alert; vite's alert was already patched below the bump (patched 7.3.0, bump from 7.3.6).
    const out = sec.securityFixes({ root: r.root, ref: "refs/tags/v1.1.0", since: "v1.0.0", stream: ONE.default,
      readAlerts: alerts({ ...VITE, patched: "7.3.0" }), readBody: noBody });
    assert.equal(out.status, "ok");
    assert.deepEqual(out.items, []);
    assert.equal(sec.renderSecurity(out), "");
  } finally { r.cleanup(); }
});

test("⚠️ unreadable alerts render an explicit could-not-be-read line, never an empty section", () => {
  const r = repoWithRelease();
  try {
    const out = sec.securityFixes({ root: r.root, ref: "refs/tags/v1.1.0", since: "v1.0.0", stream: ONE.default,
      readAlerts: () => { throw Object.assign(new Error("gh failed"), { stderr: "HTTP 403: Resource not accessible by integration\nmore" }); }, readBody: noBody });
    assert.equal(out.status, "unreadable");
    const text = sec.renderSecurity(out);
    assert.match(text, /^### Security\n\n_The Security section could not be read: HTTP 403: Resource not accessible by integration\. 2 Dependabot commit\(s\)/);
  } finally { r.cleanup(); }
});

test("a release with no Dependabot commits reads nothing and has no section", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "a.txt": "a\n" });
    r.git("tag", "v1.0.0");
    r.commit("feat: b (#2)", { "a.txt": "b\n" });
    const out = sec.securityFixes({ root: r.root, ref: "HEAD", since: "v1.0.0", stream: ONE.default,
      readAlerts: () => { throw new Error("must not be read"); }, readBody: noBody });
    assert.equal(out.status, "none");
    assert.equal(sec.renderSecurity(out), "");
  } finally { r.cleanup(); }
});

test("a Dependabot commit before the previous tag belongs to that release, not this one", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "package.json": "{}\n" });
    botCommit(r, "chore(deps): bump vite from 7.3.6 to 7.3.7 (#213)", { "package.json": '{"vite":"7.3.7"}\n' });
    r.git("tag", "v1.0.0");
    r.commit("feat: b (#3)", { "b.txt": "b\n" });
    r.git("tag", "v1.1.0");
    const out = sec.securityFixes({ root: r.root, ref: "refs/tags/v1.1.0", since: "v1.0.0", stream: ONE.default, readAlerts: alerts(VITE), readBody: noBody });
    assert.equal(out.status, "none");
  } finally { r.cleanup(); }
});

test("a Dependabot PR belongs to the streams whose paths it touched", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "package.json": "{}\n", "desktop/Cargo.lock": "a\n" });
    r.git("tag", "v1.0.0");
    r.git("tag", "desktop-v1.0.0");
    botCommit(r, "chore(deps): bump rustls from 0.23.45 to 0.23.46 in /desktop (#40)", { "desktop/Cargo.lock": "b\n" });
    const rustls = { name: "rustls", ghsa: "GHSA-rrrr-ssss-tttt", cve: null, patched: "0.23.46" };
    const web = sec.securityFixes({ root: r.root, ref: "HEAD", since: "v1.0.0", stream: TWO.web, readAlerts: alerts(rustls), readBody: noBody });
    const desktop = sec.securityFixes({ root: r.root, ref: "HEAD", since: "desktop-v1.0.0", stream: TWO.desktop, readAlerts: alerts(rustls), readBody: noBody });
    assert.equal(web.status, "none");
    assert.deepEqual(desktop.items.map((i) => i.name), ["rustls"]);
    assert.match(sec.renderSecurity(desktop), /`rustls` 0\.23\.45 → 0\.23\.46: \[GHSA-rrrr-ssss-tttt\]\([^)]+\) \(PR #40\)/);
  } finally { r.cleanup(); }
});

test("a squash whose message the merger rewrote is read from its PR body; an unreadable body is named, not dropped", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "package.json": "{}\n" });
    r.git("tag", "v1.0.0");
    botCommit(r, "chore(deps): bump @vitest/mocker and vitest (#1605)\n\nMerged by hand, all checks green.", { "package.json": "{\"m\":1}\n" });
    botCommit(r, "chore(deps): bump zod and friends (#1606)", { "package.json": "{\"m\":2}\n" });
    const mocker = { name: "@vitest/mocker", ghsa: "GHSA-xxxx-yyyy-zzzz", cve: null, patched: "4.1.12" };
    const bodies = { 1605: "Updates `@vitest/mocker` from 4.1.11 to 4.1.12\nUpdates `vitest` from 4.1.11 to 4.1.12" };
    const readBody = (_root, n) => { if (!(n in bodies)) throw new Error(`HTTP 404 for #${n}`); return bodies[n]; };
    const out = sec.securityFixes({ root: r.root, ref: "HEAD", since: "v1.0.0", stream: ONE.default, readAlerts: alerts(mocker), readBody });
    assert.deepEqual(out.items.map((i) => [i.name, i.pr]), [["@vitest/mocker", 1605]]);
    assert.deepEqual(out.unchecked.map((u) => u.pr), [1606]);
    assert.match(sec.renderSecurity(out), /_Not checked: 1 Dependabot commit\(s\) whose bumps could not be read \(PR #1606\)\._/);
  } finally { r.cleanup(); }
});

test("a merged dependabot/ branch counts once, as its merge", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "package.json": "{}\n" });
    r.git("tag", "v1.0.0");
    r.git("checkout", "-q", "-b", "dependabot/npm_and_yarn/vite-7.3.7");
    botCommit(r, "chore(deps): bump vite from 7.3.6 to 7.3.7", { "package.json": '{"vite":"7.3.7"}\n' });
    r.git("checkout", "-q", "main");
    r.commit("feat: other (#5)", { "b.txt": "b\n" });
    r.git("merge", "-q", "--no-ff", "-m", "Merge pull request #7 from someone/dependabot/npm_and_yarn/vite-7.3.7\n\nchore(deps): bump vite from 7.3.6 to 7.3.7", "dependabot/npm_and_yarn/vite-7.3.7");
    const out = sec.securityFixes({ root: r.root, ref: "HEAD", since: "v1.0.0", stream: ONE.default, readAlerts: alerts(VITE), readBody: noBody });
    assert.equal(out.commits, 1);
    assert.deepEqual(out.items.map((i) => [i.name, i.pr]), [["vite", 7]]);
  } finally { r.cleanup(); }
});

// ── the CLI ─────────────────────────────────────────────────────────────────

function capture(fn) {
  const out = []; const err = [];
  const o = process.stdout.write; const e = console.error;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  console.error = (...a) => { err.push(a.join(" ")); };
  // Under Actions the CLI also prints `::warning::` workflow commands to stdout; they are not the release body.
  const body = () => out.join("").split("\n").filter((l) => !l.startsWith("::")).join("\n");
  try { return { code: fn(), out: body(), err: err.join("\n") }; } finally { process.stdout.write = o; console.error = e; }
}

test("changelog release appends the Security section after the fragments", () => {
  const r = repoWithRelease();
  try {
    const res = capture(() => cli.main(["changelog", "release", "v1.1.0", "--root", r.root], { alerts: alerts(VITE), body: noBody }));
    assert.equal(res.code, 0);
    assert.equal(res.out, "_No changelog fragments name this release._\n\n### Security\n\n" +
      "- `vite` 7.3.6 → 7.3.7: [GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc) (CVE-2026-0001) (PR #213)\n");
  } finally { r.cleanup(); }
});

test("changelog release with unreadable alerts says so, warns, and still succeeds", () => {
  const r = repoWithRelease();
  try {
    const res = capture(() => cli.main(["changelog", "release", "v1.1.0", "--root", r.root],
      { alerts: () => { throw new Error("gh: command not found"); }, body: noBody }));
    assert.equal(res.code, 0);
    assert.match(res.out, /### Security\n\n_The Security section could not be read: gh: command not found\./);
    assert.match(res.err, /warning: v1\.1\.0: the Security section could not be read/);
  } finally { r.cleanup(); }
});
