// End-to-end tests of the CLI the reusable workflow and release scripts call
// (#1561): its exit codes are the contract, because a caller acts on them.
// 0 clean · 1 findings · 2 could not run, and a crash must never read as either.
//
// Zero dependencies: node --test only.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeRepo } = require("./fixture.js");

const CLI = path.join(__dirname, "cli.js");
const run = (r, args, env = {}) => {
  // GITHUB_ACTIONS is cleared so a CI run of this suite prints no annotations into the job.
  const p = spawnSync(process.execPath, [CLI, ...args, "--root", r.root], { encoding: "utf8", env: { ...r.env, GITHUB_ACTIONS: "", ...env } });
  return { code: p.status, out: p.stdout, err: p.stderr };
};

test("dead-paths: no baseline fails on an existing dead path; --write-baseline records it; then it passes", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "// see src/gone.ts\n" });
    assert.equal(run(r, ["dead-paths"]).code, 1);
    const w = run(r, ["dead-paths", "--write-baseline"]);
    assert.equal(w.code, 0, w.err);
    assert.equal(fs.readFileSync(path.join(r.root, ".github/dead-paths-baseline.json"), "utf8"), '{\n  "src/a.ts": 1\n}\n');
    r.commit("baseline");
    const ok = run(r, ["dead-paths"]);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /1 dead path\(s\) in 1 file\(s\)/);
  } finally { r.cleanup(); }
});

test("dead-paths: a NEW dead path fails, and so does a FIXED one until the baseline is lowered", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "// see src/gone.ts\n", "src/b.ts": "" });
    run(r, ["dead-paths", "--write-baseline"]);
    r.write({ "src/b.ts": "// and src/also-gone.ts\n" });
    const grew = run(r, ["dead-paths"]);
    assert.equal(grew.code, 1);
    assert.match(grew.err, /src\/b\.ts: 0 recorded, 1 now/);
    r.write({ "src/a.ts": "// fixed\n", "src/b.ts": "" });
    const shrank = run(r, ["dead-paths"]);
    assert.equal(shrank.code, 1);
    assert.match(shrank.err, /lower the baseline/);
    assert.equal(run(r, ["dead-paths", "--write-baseline"]).code, 0);
    assert.equal(run(r, ["dead-paths"]).code, 0);
    assert.equal(fs.readFileSync(path.join(r.root, ".github/dead-paths-baseline.json"), "utf8"), "{}\n");
  } finally { r.cleanup(); }
});

test("changelog check: exit 1 without a fragment, 0 with one or with the opt-out", () => {
  const r = makeRepo();
  try {
    const base = r.commit("init", { "src/a.ts": "" });
    r.git("checkout", "-q", "-b", "pr");
    r.commit("change", { "src/a.ts": "1" });
    assert.equal(run(r, ["changelog", "check", "--base", base]).code, 1);
    assert.equal(run(r, ["changelog", "check", "--base", base], { PR_BODY: "Changelog: none — test-only" }).code, 0);
    r.commit("fragment", { "changelog.d/5-a.md": "---\ntype: fixed\n---\nA fix.\n" });
    const ok = run(r, ["changelog", "check", "--base", base]);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /ok: changelog\.d\/5-a\.md/);
  } finally { r.cleanup(); }
});

test("changelog release: a release with no fragments warns and still exits 0", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    r.git("tag", "v1.0.0");
    const out = run(r, ["changelog", "release", "v1.0.0"]);
    assert.equal(out.code, 0);
    assert.match(out.err, /carries no changelog fragments/);
  } finally { r.cleanup(); }
});

test("a tag of no stream, a bad config, or a bad argument is exit 2 — could not run", () => {
  const r = makeRepo();
  try {
    r.commit("init", { "src/a.ts": "" });
    assert.equal(run(r, ["changelog", "release", "release-1"]).code, 2);
    assert.equal(run(r, ["changelog", "check"]).code, 2);
    r.commit("cfg", { ".github/fleet-checks.json": '{"changelgo": {}}' });
    const bad = run(r, ["dead-paths"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /unknown key "changelgo"/);
  } finally { r.cleanup(); }
});
