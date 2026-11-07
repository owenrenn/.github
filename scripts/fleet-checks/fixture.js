"use strict";

/**
 * A throwaway git repository for the fleet-checks suites (#1561). Every git
 * fact these tools read (tracked files, ignore rules, adding commits, tags) is
 * built for real rather than mocked, because a mock of git agrees with
 * whatever the code under test assumes about git.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Identity and signing come from the environment, so a developer's global git
// config (a signing key, a hook path) cannot change what a fixture commit is.
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
};

/** Removes a folder without letting a removal error replace the error that made the caller clean up. */
function removeQuietly(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the caller rethrows its own error */ }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-checks-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env: ENV, encoding: "utf8" });
  // The folder exists before any caller's finally does, so a failed init must remove it here.
  try { git("init", "-q", "-b", "main"); } catch (e) { removeQuietly(root); throw e; }
  const write = (files) => {
    for (const [p, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), text);
    }
  };
  const commit = (subject, files = {}) => {
    write(files);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD").trim();
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, git, write, commit, cleanup, env: ENV };
}

/**
 * A repo built by `build(r)` before it is returned. The folder exists before any caller's `finally` does, so a build
 * that throws removes it here and rethrows the build's own error.
 */
function buildRepo(build) {
  const r = makeRepo();
  try { build(r); } catch (e) { removeQuietly(r.root); throw e; }
  return r;
}

module.exports = { makeRepo, buildRepo, ENV };
