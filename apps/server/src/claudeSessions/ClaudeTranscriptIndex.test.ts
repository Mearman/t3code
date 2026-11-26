import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ClaudeTranscriptChangedError,
  readClaudeTranscriptTurn,
} from "./ClaudeTranscriptContent.ts";
import {
  ClaudeTranscriptIndex,
  claudeTranscriptSessionId,
  syncClaudeTranscriptIndex,
} from "./ClaudeTranscriptIndex.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import { claudeTranscriptStructure } from "./ClaudeTranscriptTurns.ts";

const SESSION = "00000000-0000-4000-8000-000000000002";
const jsonl = (lines: ReadonlyArray<unknown>) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

const transcriptFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  return path.join(directory, `${SESSION}.jsonl`);
});

const contentOf = (filePath: string, index: ClaudeTranscriptIndex, turnId: string) =>
  Effect.gen(function* () {
    const turn = claudeTranscriptStructure(index).turns.find(
      (candidate) => candidate.id === turnId,
    );
    if (turn === undefined) return yield* Effect.die(`No turn ${turnId}.`);
    return yield* readClaudeTranscriptTurn({ filePath, index, idScope: SESSION, turn });
  });

describe("claudeTranscriptSessionId", () => {
  it("reads a session's own transcript name and nothing else", () => {
    expect(claudeTranscriptSessionId(`${SESSION}.jsonl`)).toBe(SESSION);
    expect(claudeTranscriptSessionId(`${SESSION}.jsonl.superseded-1`)).toBeUndefined();
  });
});

describe("syncClaudeTranscriptIndex", () => {
  it.effect("reads only appended bytes, and leaves an unterminated line for later", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const first = jsonl([f.prompt("p1", null, "Hello"), f.text("a1", "p1", "Hi")]);
      const partial = JSON.stringify(f.prompt("p2", "a1", "Next"));
      yield* fileSystem.writeFileString(filePath, first + partial);
      const index = new ClaudeTranscriptIndex();

      const initial = yield* syncClaudeTranscriptIndex({ filePath, index });
      const afterInitial = index.version;
      yield* fileSystem.writeFileString(filePath, `${first}${partial}\n`);
      const resumed = yield* syncClaudeTranscriptIndex({ filePath, index });
      const afterResume = index.version;
      const idle = yield* syncClaudeTranscriptIndex({ filePath, index });

      expect(initial).toEqual({ rebuilt: false, linesRead: 2, bytesRead: first.length });
      expect(resumed).toEqual({ rebuilt: false, linesRead: 1, bytesRead: partial.length + 1 });
      expect(idle).toEqual({ rebuilt: false, linesRead: 0, bytesRead: 0 });
      expect(afterResume).toBeGreaterThan(afterInitial);
      expect(index.version).toBe(afterResume);
      expect(claudeTranscriptStructure(index).turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rebuilds from the top when the file is truncated, replaced or rewritten", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const original = jsonl([f.prompt("p1", null, "One"), f.text("a1", "p1", "Done")]);
      yield* fileSystem.writeFileString(filePath, original);
      const index = new ClaudeTranscriptIndex();
      yield* syncClaudeTranscriptIndex({ filePath, index });

      yield* fileSystem.writeFileString(filePath, jsonl([f.prompt("q1", null, "Other")]));
      const truncated = yield* syncClaudeTranscriptIndex({ filePath, index });
      const afterTruncation = claudeTranscriptStructure(index).turns.map((turn) => turn.id);

      const rewritten = original.replace("One", "Uno") + jsonl([f.prompt("p2", "a1", "Two")]);
      yield* fileSystem.writeFileString(filePath, rewritten);
      const edited = yield* syncClaudeTranscriptIndex({ filePath, index });

      const replacement = `${filePath}.next`;
      yield* fileSystem.writeFileString(replacement, rewritten);
      yield* fileSystem.rename(replacement, filePath);
      const replaced = yield* syncClaudeTranscriptIndex({ filePath, index });

      expect([truncated.rebuilt, edited.rebuilt, replaced.rebuilt]).toEqual([true, true, true]);
      expect(afterTruncation).toEqual(["q1"]);
      expect(claudeTranscriptStructure(index).turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives the same turns whether the file is read whole or as it grows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const text = jsonl([
        f.prompt("p0", null, "Go"),
        f.toolUse("a0", "p0", "t0"),
        f.prompt("p1", "a0", "Next"),
        f.result("r0", "a0", "t0"),
        f.text("a1", "p1", "Done"),
      ]);
      const whole = new ClaudeTranscriptIndex();
      yield* fileSystem.writeFileString(filePath, text);
      yield* syncClaudeTranscriptIndex({ filePath, index: whole });
      const growing = new ClaudeTranscriptIndex();
      for (let cut = 1; cut <= text.length; cut += 37) {
        yield* fileSystem.writeFileString(filePath, text.slice(0, cut));
        yield* syncClaudeTranscriptIndex({ filePath, index: growing });
      }
      yield* fileSystem.writeFileString(filePath, text);
      yield* syncClaudeTranscriptIndex({ filePath, index: growing });

      expect(claudeTranscriptStructure(growing)).toEqual(claudeTranscriptStructure(whole));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("records lines that are not records, and keeps no text of any line", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const before = jsonl([f.prompt("p1", null, "A secret prompt that is long")]);
      yield* fileSystem.writeFileString(
        filePath,
        `${before}not json\n\n${jsonl([f.text("a1", "p1", "Reply")])}`,
      );
      const index = new ClaudeTranscriptIndex();
      yield* syncClaudeTranscriptIndex({ filePath, index });

      expect(index.malformedOffsets).toEqual([before.length]);
      expect(index.footprint().stringCharacters).toBe("p1".length + "a1".length + "pid-p1".length);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("readClaudeTranscriptTurn", () => {
  it.effect("reads a turn's items by offset, in the turn's order, with stable ids", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      yield* fileSystem.writeFileString(
        filePath,
        jsonl([
          f.prompt("p1", null, "Run it", { origin: { kind: "human" } }),
          f.toolUse("a1", "p1", "t1", null),
          f.command("c1", "a1", "status"),
          f.result("r1", "a1", "t1"),
          f.queued("q1", "r1", "Also this"),
          f.user(
            "o1",
            "q1",
            "<bash-stdout>see </bash-stdout> here</bash-stdout><bash-stderr></bash-stderr>",
            {
              forkedFrom: { sessionId: "s0", messageUuid: "m0" },
            },
          ),
          f.boundary("b1", "o1"),
          f.user("x1", "b1", [{ type: "tool_use" }]),
        ]),
      );
      const index = new ClaudeTranscriptIndex();
      yield* syncClaudeTranscriptIndex({ filePath, index });
      const content = yield* contentOf(filePath, index, "p1");

      expect(content.prompt).toMatchObject({
        text: "Run it",
        promptId: "pid-p1",
        originKind: "human",
        hidden: false,
      });
      expect(content.items.map((item) => [item._tag, item.id])).toEqual([
        ["Block", `x:${SESSION}:p1`],
        ["Block", `x:${SESSION}:a1:0`],
        ["Command", `x:${SESSION}:c1`],
        ["Block", `x:${SESSION}:r1:0`],
        ["QueuedPrompt", `x:${SESSION}:q1`],
        ["CommandOutput", `x:${SESSION}:o1`],
        ["Compaction", `x:${SESSION}:b1`],
        ["Unreadable", `x:${SESSION}:x1`],
      ]);
      expect(content.items[2]).toMatchObject({ text: "/status" });
      expect(content.items[5]).toMatchObject({
        output: [
          { stream: "stdout", text: "see </bash-stdout> here" },
          { stream: "stderr", text: "" },
        ],
        forkedFrom: { sessionId: "s0", messageUuid: "m0" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives a queued or meta turn its prompt, and an orphan none", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      yield* fileSystem.writeFileString(
        filePath,
        jsonl([
          f.text("a0", "gone", "Mid-turn"),
          f.prompt("p1", "a0", "Go"),
          f.text("a1", "p1", "Done"),
          f.queued("q1", "a1", "Then this"),
          f.text("a2", "q1", "Ok"),
          f.meta("m1", "a2", "pid-m1", "<task-notification>Finished</task-notification>", {
            origin: { kind: "task-notification" },
          }),
          f.text("a3", "m1", "Noted"),
        ]),
      );
      const index = new ClaudeTranscriptIndex();
      yield* syncClaudeTranscriptIndex({ filePath, index });

      expect((yield* contentOf(filePath, index, "a0")).prompt).toBeUndefined();
      expect((yield* contentOf(filePath, index, "q1")).prompt).toMatchObject({
        text: "Then this",
        promptId: "pid-p1",
        hidden: false,
      });
      const meta = yield* contentOf(filePath, index, "m1");
      expect(meta.prompt).toMatchObject({
        promptId: "pid-m1",
        originKind: "task-notification",
        hidden: true,
      });
      expect(meta.items.map((item) => item.lineUuid)).toEqual(["a3"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails rather than read another line where an indexed one was", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const text = jsonl([f.prompt("p1", null, "Hello"), f.text("a1", "p1", "Hi")]);
      yield* fileSystem.writeFileString(filePath, text);
      const index = new ClaudeTranscriptIndex();
      yield* syncClaudeTranscriptIndex({ filePath, index });
      yield* fileSystem.writeFileString(filePath, text.replace("Hello", "Howdy"));

      const failure = yield* Effect.flip(contentOf(filePath, index, "p1"));

      expect(failure).toBeInstanceOf(ClaudeTranscriptChangedError);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
