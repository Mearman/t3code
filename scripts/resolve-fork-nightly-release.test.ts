// @effect-diagnostics nodeBuiltinImport:off - Rewrites a temporary repository's history with git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  forkNightlyBuildNumber,
  publishedNightlyNotOlderThan,
} from "./lib/fork-nightly-version.ts";
import { resolveForkNightlyRelease } from "./resolve-fork-nightly-release.ts";
import { resolveNightlyReleaseMetadata } from "./resolve-nightly-release.ts";

const DAY = "20261127";

function makeMain() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-nightly-version-"));
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      // A hook's GIT_DIR would point these at the repository under test.
      { cwd: root, encoding: "utf8", stdio: "pipe", env: { PATH: process.env.PATH } },
    ).trim();
  NodeFS.mkdirSync(NodePath.join(root, "apps/desktop"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "apps/desktop/package.json"),
    JSON.stringify({ version: "0.1.12" }),
  );
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "base");
  const commit = (message: string) => {
    git("commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit, [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true }) };
}

it("numbers a nightly by depth, above every nightly already published that day", () => {
  assert.equal(forkNightlyBuildNumber(DAY, 40, []), 40);
  assert.equal(forkNightlyBuildNumber(DAY, 40, [`v0.1.13-nightly.${DAY}.40`]), 41);
  assert.equal(forkNightlyBuildNumber(DAY, 38, [`v0.1.13-nightly.${DAY}.40`, "v0.1.12"]), 41);
  assert.equal(forkNightlyBuildNumber(DAY, 38, ["v0.1.13-nightly.20261126.90"]), 38);
  assert.equal(forkNightlyBuildNumber(DAY, 38, ["update-feed", "desktop-preview"]), 38);
});

it("finds a published nightly that a version is not newer than", () => {
  const published = [`v0.1.13-nightly.${DAY}.40`, "v0.1.12", "update-feed"];
  assert.isUndefined(publishedNightlyNotOlderThan(`0.1.13-nightly.${DAY}.41`, published));
  assert.equal(
    publishedNightlyNotOlderThan(`0.1.13-nightly.${DAY}.40`, published),
    `0.1.13-nightly.${DAY}.40`,
  );
  assert.equal(
    publishedNightlyNotOlderThan("0.1.13-nightly.20261126.90", published),
    `0.1.13-nightly.${DAY}.40`,
  );
});

it.layer(NodeServices.layer)("fork nightly version after main is rewritten", (it) => {
  it.effect("stays above the published release when a rewrite repeats or lowers the depth", () =>
    Effect.gen(function* () {
      using main = makeMain();
      for (let index = 0; index < 4; index++) main.commit(`fork ${index}`);
      const released = main.commit("released tip");
      const resolve = (sha: string, publishedTags: ReadonlyArray<string>) =>
        resolveForkNightlyRelease({ date: DAY, sha, publishedTags, root: main.root });

      const first = yield* resolve(released, []);
      assert.equal(first.version, `0.1.13-nightly.${DAY}.6`);
      const published = [first.tag];

      // An amended tip is a different commit at the same depth.
      main.git("reset", "--quiet", "--hard", "HEAD~1");
      const amended = main.commit("amended tip");
      assert.equal((yield* resolve(amended, published)).version, `0.1.13-nightly.${DAY}.7`);

      // A sync that drops more commits than it adds lowers the depth.
      main.git("reset", "--quiet", "--hard", "HEAD~3");
      const synced = main.commit("synced tip");
      assert.equal((yield* resolve(synced, published)).version, `0.1.13-nightly.${DAY}.7`);

      // A later day starts from the depth again.
      const nextDay = yield* resolveForkNightlyRelease({
        date: "20261128",
        sha: synced,
        publishedTags: published,
        root: main.root,
      });
      assert.equal(nextDay.version, "0.1.13-nightly.20261128.4");

      // A lower base version (an upstream sync that reverted one) cannot pass a published nightly.
      main.git("commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "noop");
      const refused = yield* resolveForkNightlyRelease({
        date: "20261128",
        sha: main.git("rev-parse", "HEAD"),
        publishedTags: [...published, "v0.2.0-nightly.20261127.1"],
        root: main.root,
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "ForkNightlyVersionNotNewerError");
    }),
  );
});

it("titles a release with the given product name", () => {
  assert.equal(
    resolveNightlyReleaseMetadata("0.1.13", DAY, 41, "a".repeat(40), "nightly", "ExaCode").name,
    `ExaCode Nightly 0.1.13-nightly.${DAY}.41 (${"a".repeat(12)})`,
  );
  assert.equal(
    resolveNightlyReleaseMetadata("0.1.13", DAY, 41, "a".repeat(40)).name,
    `T3 Code Nightly 0.1.13-nightly.${DAY}.41 (${"a".repeat(12)})`,
  );
});
