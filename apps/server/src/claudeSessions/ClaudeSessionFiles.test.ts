import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeTranscriptEndsCompacted,
  copyClaudeSession,
  listClaudeSessionFiles,
  locateClaudeTranscript,
} from "./ClaudeSessionFiles.ts";

const session = "11111111-2222-3333-4444-555555555555";
const projectDir = "-work-repo";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

const homes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const source = path.join(root, "personal");
  const target = path.join(root, "work");
  const write = (home: string, relative: string, text: string) =>
    fileSystem
      .makeDirectory(path.dirname(path.join(home, relative)), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(path.join(home, relative), text)));
  const sessionFiles: Record<string, string> = {
    [`projects/${projectDir}/${session}.jsonl`]: line({ type: "user", message: "hi" }),
    [`projects/${projectDir}/${session}/subagents/agent-a.jsonl`]: "subagent\n",
    [`projects/${projectDir}/${session}/tool-results/out.txt`]: "tool output",
    [`projects/${projectDir}/${session}/mcp-tasks/mcp-task-1.meta.json`]: "{}",
    [`file-history/${session}/backup@v1`]: "backup",
    [`tasks/${session}/task.json`]: "{}",
  };
  for (const [relative, text] of Object.entries(sessionFiles)) yield* write(source, relative, text);
  yield* write(source, `projects/${projectDir}/other-session.jsonl`, "other\n");
  yield* write(source, "file-history/other-session/backup@v1", "other");
  yield* fileSystem.makeDirectory(target);
  return { fileSystem, path, source, target, write, sessionFiles };
});

it.effect("finds a session's transcript and every sidecar, and nothing of other sessions", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    assert.strictEqual(yield* locateClaudeTranscript(h.source, session), projectDir);
    assert.isUndefined(yield* locateClaudeTranscript(h.target, session));
    assert.deepEqual(
      yield* listClaudeSessionFiles(h.source, projectDir, session),
      Object.keys(h.sessionFiles).toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("treats only a transcript whose last turn is a compaction as compacted", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const file = h.path.join(h.source, "check.jsonl");
    const boundary = line({ type: "system", subtype: "compact_boundary" });
    const summary = line({ type: "user", isCompactSummary: true, message: "summary" });
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      [line({ type: "user", message: "hi" }), false],
      [boundary + summary, true],
      [boundary + summary + line({ type: "user", isMeta: true, message: "meta" }), true],
      [boundary + summary + line({ type: "user", message: "next" }), false],
      [boundary + summary + line({ type: "assistant", message: "reply" }), false],
      [`${line({ type: "user", message: "x" }).repeat(3)}${boundary}${summary}`, true],
    ];
    for (const [text, expected] of cases) {
      yield* h.fileSystem.writeFileString(file, text);
      assert.strictEqual(yield* claudeTranscriptEndsCompacted(file), expected, text);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("copies every file byte for byte, then links each original to its copy", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const files = yield* listClaudeSessionFiles(h.source, projectDir, session);
    yield* copyClaudeSession({ source: h.source, target: h.target, files, linkOriginals: true });
    for (const relative of files) {
      const original = h.path.join(h.source, relative);
      const copy = h.path.join(h.target, relative);
      assert.strictEqual(yield* h.fileSystem.readFileString(copy), h.sessionFiles[relative]);
      assert.strictEqual(yield* h.fileSystem.readLink(original), copy);
    }
    // One history: a write through the old home's link lands in the new home's file.
    const transcript = `projects/${projectDir}/${session}.jsonl`;
    yield* h.fileSystem.writeFileString(h.path.join(h.source, transcript), "appended\n", {
      flag: "a",
    });
    assert.include(
      yield* h.fileSystem.readFileString(h.path.join(h.target, transcript)),
      "appended",
    );
    assert.strictEqual(
      yield* h.fileSystem.readFileString(
        h.path.join(h.source, `projects/${projectDir}/other-session.jsonl`),
      ),
      "other\n",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("replaces nothing when a copy does not match, and removes the copies it made", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const files = yield* listClaudeSessionFiles(h.source, projectDir, session);
    const failure = yield* copyClaudeSession({
      source: h.source,
      target: h.target,
      files,
      linkOriginals: true,
      afterCopy: (copy) =>
        copy.endsWith("out.txt") ? h.fileSystem.writeFileString(copy, "corrupted") : Effect.void,
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ClaudeSessionCopyMismatchError");
    for (const relative of files) {
      const original = h.path.join(h.source, relative);
      assert.strictEqual((yield* h.fileSystem.stat(original)).type, "File");
      assert.isFalse((yield* h.fileSystem.readLink(original).pipe(Effect.option))._tag === "Some");
      assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, relative)));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses to overwrite a different file the other account already has", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const files = yield* listClaudeSessionFiles(h.source, projectDir, session);
    yield* h.write(h.target, `tasks/${session}/task.json`, "theirs");
    const failure = yield* copyClaudeSession({
      source: h.source,
      target: h.target,
      files,
      linkOriginals: true,
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ClaudeSessionTargetConflictError");
    assert.strictEqual(
      yield* h.fileSystem.readFileString(h.path.join(h.target, `tasks/${session}/task.json`)),
      "theirs",
    );
    for (const relative of files) {
      assert.isTrue(
        (yield* h.fileSystem.readLink(h.path.join(h.source, relative)).pipe(Effect.option))._tag ===
          "None",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves originals in place when linking is off", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const files = yield* listClaudeSessionFiles(h.source, projectDir, session);
    yield* copyClaudeSession({ source: h.source, target: h.target, files, linkOriginals: false });
    for (const relative of files) {
      assert.isTrue(
        (yield* h.fileSystem.readLink(h.path.join(h.source, relative)).pipe(Effect.option))._tag ===
          "None",
      );
      assert.isTrue(yield* h.fileSystem.exists(h.path.join(h.target, relative)));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
