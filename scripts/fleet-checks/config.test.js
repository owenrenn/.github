// Tests for the per-repo fleet-checks config (#1561). Validation refuses rather
// than defaults: a typo silently ignored reads as a check that ran.
//
// Zero dependencies: node --test only.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize, ConfigError, DEFAULT_STREAMS } = require("./config.js");

test("no config is one stream, tagged v, that every path ships in", () => {
  const c = normalize({});
  assert.deepEqual(c.streams, DEFAULT_STREAMS);
  assert.equal(c.deadPaths.comments, true);
  assert.deepEqual([...c.deadPaths.linksResolveElsewhere], []);
});

test("an unknown key is refused, at every level", () => {
  assert.throws(() => normalize({ changelgo: {} }), ConfigError);
  assert.throws(() => normalize({ changelog: { stream: {} } }), /unknown key "stream"/);
  assert.throws(() => normalize({ changelog: { streams: { web: { tagPrefix: "v", paths: ["**"], exclude: [] } } } }), /unknown key "exclude"/);
});

test("two streams cannot share a prefix, and `all`/`both` are not stream names", () => {
  const s = (streams) => () => normalize({ changelog: { streams } });
  assert.throws(s({ a: { tagPrefix: "v", paths: ["**"] }, b: { tagPrefix: "v", paths: ["x/**"] } }), /also a's/);
  assert.throws(s({ both: { tagPrefix: "v", paths: ["**"] } }), /reserved/);
  assert.throws(s({ web: { tagPrefix: "v*", paths: ["**"] } }), /literal prefix/);
  assert.throws(s({ web: { tagPrefix: "v", paths: [] } }), /name the paths/);
});

test("a dead-path exemption needs a reason", () => {
  assert.throws(() => normalize({ deadPaths: { exempt: [{ glob: "docs/x/" }] } }), /why/);
  const c = normalize({ deadPaths: { exempt: [{ glob: "docs/x/", why: "an imported wiki, frozen" }], foreignNames: ["other"] } });
  assert.equal(c.deadPaths.exempt[0].glob, "docs/x/");
  assert.deepEqual(c.deadPaths.foreignNames, ["other"]);
});

test("a non-list exemption, or a non-object config, is a named ConfigError, not a TypeError", () => {
  // Review finding G (#1561).
  assert.throws(() => normalize({ deadPaths: { exempt: "docs/" } }), /deadPaths\.exempt: expected a list/);
  assert.throws(() => normalize(null), ConfigError);
  assert.throws(() => normalize({ deadPaths: { exempt: [null] } }), ConfigError);
});

test("the fragment check is on by default, and `changelog: true` or an object keeps it on", () => {
  assert.equal(normalize({}).changelog, true);
  assert.equal(normalize({ changelog: true }).changelog, true);
  assert.deepEqual(normalize({ changelog: true }).streams, DEFAULT_STREAMS);
  assert.equal(normalize({ changelog: { streams: { web: { tagPrefix: "v", paths: ["**"] } } } }).changelog, true);
});

test("`changelog: false` turns the fragment check off and leaves the dead-path config as declared", () => {
  // PM ruling on #1694: a repo that ships no release runs only the dead-path ratchet.
  const c = normalize({ changelog: false, deadPaths: { foreignNames: ["other"] } });
  assert.equal(c.changelog, false);
  assert.deepEqual(c.deadPaths.foreignNames, ["other"]);
});

test("a `changelog` that is neither a boolean nor an object is refused, named", () => {
  for (const v of ["false", "no", 0, 1, [], ["streams"]]) {
    assert.throws(() => normalize({ changelog: v }), /changelog: true, false, or an object/, JSON.stringify(v));
  }
});
