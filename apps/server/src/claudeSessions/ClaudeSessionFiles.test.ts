import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  claudeTranscriptEndsCompacted,
  listClaudeSessionParts,
  locateClaudeTranscript,
  moveClaudeSessionParts,
} from "./ClaudeSessionFiles.ts";

const session = "11111111-2222-3333-4444-555555555555";
const projectDir = "-work-repo";
const transcript = `projects/${projectDir}/${session}.jsonl`;
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
    [transcript]: line({ type: "user", message: "hi" }),
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
  const parts = yield* listClaudeSessionParts(source, projectDir, session);
  const isLink = (file: string) =>
    fileSystem.readLink(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const leftovers = (home: string) =>
    fileSystem
      .readDirectory(home, { recursive: true })
      .pipe(Effect.map((entries) => entries.filter((entry) => entry.includes(".t3-move"))));
  return { fileSystem, path, source, target, write, sessionFiles, parts, isLink, leftovers };
});

const failWith = (message: string) =>
  Effect.fail(
    PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: message }),
  );

it.effect("finds a session's transcript and each part, and nothing of other sessions", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    assert.strictEqual(yield* locateClaudeTranscript(h.source, session), projectDir);
    assert.isUndefined(yield* locateClaudeTranscript(h.target, session));
    assert.deepEqual(h.parts, [
      transcript,
      `projects/${projectDir}/${session}`,
      `file-history/${session}`,
      `tasks/${session}`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("treats only a transcript whose last turn is a compaction as compacted", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const file = h.path.join(h.source, "check.jsonl");
    const boundary = line({ type: "system", subtype: "compact_boundary" });
    const summary = line({ type: "user", isCompactSummary: true, message: "summary" });
    // What `/compact` writes after its summary: a meta caveat, the command and its output.
    const command =
      line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>x" } }) +
      line({ type: "user", message: { content: "<command-name>/compact</command-name>" } }) +
      line({
        type: "user",
        message: { content: [{ type: "text", text: "<local-command-stdout>Done" }] },
      });
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      [line({ type: "user", message: "hi" }), false],
      [boundary + summary, true],
      [boundary + summary + command, true],
      [boundary + summary + line({ type: "attachment" }) + command, true],
      [boundary + summary + line({ type: "user", isMeta: true, message: "meta" }), true],
      [boundary + summary + line({ type: "user", message: "next" }), false],
      [boundary + summary + command + line({ type: "user", message: "next" }), false],
      [boundary + summary + line({ type: "assistant", message: "reply" }), false],
      [`${line({ type: "user", message: "x" }).repeat(3)}${boundary}${summary}`, true],
    ];
    for (const [text, expected] of cases) {
      yield* h.fileSystem.writeFileString(file, text);
      assert.strictEqual(yield* claudeTranscriptEndsCompacted(file), expected, text);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("copies every file byte for byte, then links each part to its copy", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const moved = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
    });
    yield* moved.commit;
    assert.isTrue(moved.copied);
    for (const [relative, text] of Object.entries(h.sessionFiles)) {
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.target, relative)), text);
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.source, relative)), text);
    }
    for (const part of h.parts)
      assert.strictEqual(
        yield* h.fileSystem.readLink(h.path.join(h.source, part)),
        h.path.join(h.target, part),
      );
    assert.deepEqual(yield* h.leftovers(h.source), []);
    // One history: writes through the old home, even new sidecar files, land in the new home.
    yield* h.fileSystem.writeFileString(h.path.join(h.source, transcript), "appended\n", {
      flag: "a",
    });
    yield* h.write(h.source, `projects/${projectDir}/${session}/subagents/agent-b.jsonl`, "later");
    assert.include(
      yield* h.fileSystem.readFileString(h.path.join(h.target, transcript)),
      "appended",
    );
    assert.isTrue(
      yield* h.fileSystem.exists(
        h.path.join(h.target, `projects/${projectDir}/${session}/subagents/agent-b.jsonl`),
      ),
    );
    assert.strictEqual(
      yield* h.fileSystem.readFileString(
        h.path.join(h.source, `projects/${projectDir}/other-session.jsonl`),
      ),
      "other\n",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("moving a session back keeps its only real copy and its history in both homes", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const there = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
    });
    yield* there.commit;
    const back = yield* moveClaudeSessionParts({
      source: h.target,
      target: h.source,
      parts: yield* listClaudeSessionParts(h.target, projectDir, session),
      linkOriginals: true,
    });
    yield* back.commit;
    assert.isFalse(back.copied);
    for (const part of h.parts) assert.isFalse(yield* h.isLink(h.path.join(h.target, part)));
    for (const [relative, text] of Object.entries(h.sessionFiles)) {
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.source, relative)), text);
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.target, relative)), text);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("replaces nothing when a copy does not match, and removes the copies it made", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const failure = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
      afterCopy: (copy) =>
        copy.endsWith("out.txt") ? h.fileSystem.writeFileString(copy, "corrupted") : Effect.void,
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ClaudeSessionCopyMismatchError");
    for (const relative of Object.keys(h.sessionFiles)) {
      assert.isFalse(yield* h.isLink(h.path.join(h.source, relative)));
      assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, relative)));
    }
    assert.deepEqual(yield* h.fileSystem.readDirectory(h.target), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("puts every part back when replacing one fails part-way", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const failure = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
      beforeReplace: (part) => (part === h.parts[2] ? failWith("symlink") : Effect.void),
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "PlatformError");
    for (const [relative, text] of Object.entries(h.sessionFiles)) {
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.source, relative)), text);
      assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, relative)));
    }
    for (const part of h.parts) assert.isFalse(yield* h.isLink(h.path.join(h.source, part)));
    assert.deepEqual(yield* h.leftovers(h.source), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("undo puts a finished move back exactly", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    const moved = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
    });
    yield* moved.undo;
    for (const [relative, text] of Object.entries(h.sessionFiles)) {
      assert.strictEqual(yield* h.fileSystem.readFileString(h.path.join(h.source, relative)), text);
      assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, relative)));
    }
    for (const part of h.parts) assert.isFalse(yield* h.isLink(h.path.join(h.source, part)));
    assert.deepEqual(yield* h.leftovers(h.source), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses to overwrite a different file the other account already has", () =>
  Effect.gen(function* () {
    const h = yield* homes;
    yield* h.write(h.target, `tasks/${session}/task.json`, "theirs");
    const failure = yield* moveClaudeSessionParts({
      source: h.source,
      target: h.target,
      parts: h.parts,
      linkOriginals: true,
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "ClaudeSessionTargetConflictError");
    assert.strictEqual(
      yield* h.fileSystem.readFileString(h.path.join(h.target, `tasks/${session}/task.json`)),
      "theirs",
    );
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcript)));
    for (const part of h.parts) assert.isFalse(yield* h.isLink(h.path.join(h.source, part)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "with linking off, sets the originals aside so the old home cannot fork the history",
  () =>
    Effect.gen(function* () {
      const h = yield* homes;
      const moved = yield* moveClaudeSessionParts({
        source: h.source,
        target: h.target,
        parts: h.parts,
        linkOriginals: false,
      });
      yield* moved.commit;
      assert.isUndefined(yield* locateClaudeTranscript(h.source, session));
      for (const part of h.parts) {
        assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.source, part)));
        assert.isTrue(yield* h.fileSystem.exists(h.path.join(h.source, `${part}.t3-moved`)));
        assert.isTrue(yield* h.fileSystem.exists(h.path.join(h.target, part)));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
