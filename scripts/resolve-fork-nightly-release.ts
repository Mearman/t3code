#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Counts the release commit's history with git.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  forkNightlyBuildNumber,
  publishedNightlyNotOlderThan,
} from "./lib/fork-nightly-version.ts";
import {
  readDesktopBaseVersion,
  resolveNightlyReleaseMetadata,
  writeNightlyReleaseOutput,
} from "./resolve-nightly-release.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

export class ForkNightlyVersionNotNewerError extends Schema.TaggedError<ForkNightlyVersionNotNewerError>()(
  "ForkNightlyVersionNotNewerError",
  { version: Schema.String, published: Schema.String },
) {
  override get message(): string {
    return `Nightly ${this.version} is not newer than the published ${this.published}.`;
  }
}

/**
 * The version of a fork nightly of `sha` cut on `date`, given every published release tag. It is
 * newer than every published nightly even after main is rewritten, and fails if it cannot be.
 */
export const resolveForkNightlyRelease = Effect.fn("resolveForkNightlyRelease")(function* (input: {
  readonly date: string;
  readonly sha: string;
  readonly publishedTags: ReadonlyArray<string>;
  readonly root?: string | undefined;
}) {
  const root = input.root ?? REPO_ROOT;
  const baseVersion = yield* readDesktopBaseVersion(root);
  const depth = Number(
    NodeChildProcess.execFileSync("git", ["rev-list", "--count", "--first-parent", input.sha], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  );
  const build = forkNightlyBuildNumber(input.date, depth, input.publishedTags);
  const metadata = resolveNightlyReleaseMetadata(baseVersion, input.date, build, input.sha);
  const published = publishedNightlyNotOlderThan(metadata.version, input.publishedTags);
  if (published !== undefined) {
    return yield* new ForkNightlyVersionNotNewerError({ version: metadata.version, published });
  }
  return metadata;
});

const command = Command.make(
  "resolve-fork-nightly-release",
  {
    date: Flag.String("date").pipe(Flag.withDescription("Nightly build date in YYYYMMDD.")),
    sha: Flag.String("sha").pipe(Flag.withDescription("Commit sha for the nightly build.")),
    publishedTags: Flag.String("published-tags").pipe(
      Flag.withDescription("File listing every published release's tag, one per line."),
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ date, sha, publishedTags, githubOutput }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tags = (yield* fs.readFileString(publishedTags)).split("\n").filter(Boolean);
      const metadata = yield* resolveForkNightlyRelease({ date, sha, publishedTags: tags });
      yield* writeNightlyReleaseOutput(metadata, githubOutput);
    }),
).pipe(Command.withDescription("Resolve a fork nightly's version above every published one."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
