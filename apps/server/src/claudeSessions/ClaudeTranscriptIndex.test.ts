import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ClaudeTranscriptChangedError,
  readClaudeTranscriptTurn,
  type ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import { claudeTranscriptSessionId } from "./ClaudeTranscriptIndex.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import {
  ClaudeTranscriptTurnTracker,
  syncClaudeTranscript,
} from "./ClaudeTranscriptTurnTracker.ts";
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

const contentOf = (
  filePath: string,
  tracker: ClaudeTranscriptTurnTracker,
  turnId: string,
  known: ReadonlyMap<string, number> = new Map(),
) =>
  Effect.gen(function* () {
    const turn = tracker.turn(turnId);
    if (turn === undefined) return yield* Effect.die(`No turn ${turnId}.`);
    return yield* readClaudeTranscriptTurn({
      filePath,
      index: tracker.index,
      idScope: SESSION,
      turn,
      known,
    });
  });
const itemsOf = (content: ClaudeTranscriptTurnContent) =>
  content.lines.flatMap((line) => line.items);
const turnIds = (tracker: ClaudeTranscriptTurnTracker) => tracker.turnIds();

// Same-length lines, so an edit can be placed at any byte without moving the others.
const paddedLines = (count: number) => {
  const f = claudeTranscriptFixture();
  const lines = [f.prompt("p0", null, "Go")];
  for (let index = 1; index < count; index++) {
    lines.push(
      f.text(
        `a${index.toString().padStart(4, "0")}`,
        index === 1 ? "p0" : `a${(index - 1).toString().padStart(4, "0")}`,
        `Line ${"x".repeat(900)}`,
        null,
      ),
    );
  }
  return jsonl(lines);
};

describe("claudeTranscriptSessionId", () => {
  it("reads a session's own transcript name and nothing else", () => {
    expect(claudeTranscriptSessionId(`${SESSION}.jsonl`)).toBe(SESSION);
    expect(claudeTranscriptSessionId(`${SESSION}.jsonl.superseded-1`)).toBeUndefined();
  });
});

describe("syncClaudeTranscript", () => {
  it.effect("reads only appended bytes, and leaves an unterminated line for later", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const first = jsonl([f.prompt("p1", null, "Hello"), f.text("a1", "p1", "Hi")]);
      const partial = JSON.stringify(f.prompt("p2", "a1", "Next"));
      yield* fileSystem.writeFileString(filePath, first + partial);
      const tracker = new ClaudeTranscriptTurnTracker();

      const initial = yield* syncClaudeTranscript({ filePath, tracker });
      yield* fileSystem.writeFileString(filePath, `${first}${partial}\n`);
      const resumed = yield* syncClaudeTranscript({ filePath, tracker });
      const idle = yield* syncClaudeTranscript({ filePath, tracker });

      expect(initial).toMatchObject({
        rewritten: false,
        linesRead: 2,
        bytesRead: first.length,
        changedTurnIds: ["p1"],
      });
      expect(resumed).toMatchObject({
        rewritten: false,
        linesRead: 1,
        bytesRead: partial.length + 1,
      });
      expect(resumed.changedTurnIds).toEqual(["p2"]);
      expect(idle).toMatchObject({
        linesRead: 0,
        bytesRead: 0,
        changedTurnIds: [],
        removedTurnIds: [],
      });
      expect(turnIds(tracker)).toEqual(["p1", "p2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rebuilds from the top when the file is truncated, replaced or rewritten", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const original = jsonl([f.prompt("p1", null, "One"), f.text("a1", "p1", "Done")]);
      yield* fileSystem.writeFileString(filePath, original);
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });

      yield* fileSystem.writeFileString(filePath, jsonl([f.prompt("q1", null, "Other")]));
      const truncated = yield* syncClaudeTranscript({ filePath, tracker });
      const afterTruncation = turnIds(tracker);

      const rewritten = original.replace("One", "Uno") + jsonl([f.prompt("p2", "a1", "Two")]);
      yield* fileSystem.writeFileString(filePath, rewritten);
      const edited = yield* syncClaudeTranscript({ filePath, tracker });

      const replacement = `${filePath}.next`;
      yield* fileSystem.writeFileString(replacement, rewritten);
      yield* fileSystem.rename(replacement, filePath);
      const replaced = yield* syncClaudeTranscript({ filePath, tracker });

      expect([truncated.rewritten, edited.rewritten, replaced.rewritten]).toEqual([
        true,
        true,
        true,
      ]);
      expect(truncated).toMatchObject({ removedTurnIds: ["p1"], changedTurnIds: ["q1"] });
      expect(edited.removedTurnIds).toEqual(["q1"]);
      expect(afterTruncation).toEqual(["q1"]);
      expect(turnIds(tracker)).toEqual(["p1", "p2"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Rewrite inspection finding 11: each guard window catches an edit the other cannot see.
  it.effect.each([
    ["the head window", () => 10 * 1024],
    ["the tail window", (size: number) => size - 10 * 1024],
  ] as const)("rebuilds after a same-length edit seen only by %s", ([, place]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const text = paddedLines(200);
      const at = place(text.length);
      const window = 64 * 1024;
      // Inside exactly one of the first and last 64 KiB.
      expect(at < window !== at >= text.length - window).toBe(true);
      yield* fileSystem.writeFileString(filePath, text);
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });
      const edit = text.indexOf("x", at);
      yield* fileSystem.writeFileString(filePath, `${text.slice(0, edit)}y${text.slice(edit + 1)}`);

      const synced = yield* syncClaudeTranscript({ filePath, tracker });

      expect(synced.rewritten).toBe(true);
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
      const whole = new ClaudeTranscriptTurnTracker();
      yield* fileSystem.writeFileString(filePath, text);
      yield* syncClaudeTranscript({ filePath, tracker: whole });
      const growing = new ClaudeTranscriptTurnTracker();
      for (let cut = 1; cut <= text.length; cut += 37) {
        yield* fileSystem.writeFileString(filePath, text.slice(0, cut));
        yield* syncClaudeTranscript({ filePath, tracker: growing });
      }
      yield* fileSystem.writeFileString(filePath, text);
      yield* syncClaudeTranscript({ filePath, tracker: growing });

      expect(growing.structure()).toEqual(whole.structure());
      expect(whole.structure()).toEqual(claudeTranscriptStructure(whole.index));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Rewrite inspection finding 8: an appended malformed line is reported and changes the version.
  it.effect("reports a malformed line appended on its own, and keeps no text of any line", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const before = jsonl([f.prompt("p1", null, "A secret prompt that is long")]);
      yield* fileSystem.writeFileString(filePath, before);
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });
      const version = tracker.index.version;
      yield* fileSystem.writeFileString(filePath, `${before}{"type":"user","uuid":"x"\n`);

      const synced = yield* syncClaudeTranscript({ filePath, tracker });

      expect(synced.malformedOffsets).toEqual([before.length]);
      expect(tracker.index.version).not.toBe(version);
      expect(tracker.index.footprint().stringCharacters).toBe("p1".length + "pid-p1".length);
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
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });
      const content = yield* contentOf(filePath, tracker, "p1");
      const items = itemsOf(content);

      expect(content.opener?.prompt).toMatchObject({
        text: "Run it",
        promptId: "pid-p1",
        originKind: "human",
        hidden: false,
      });
      expect(items.map((item) => [item._tag, item.id])).toEqual([
        ["Block", `x:${SESSION}:p1`],
        ["Block", `x:${SESSION}:a1:0`],
        ["Command", `x:${SESSION}:c1`],
        ["Block", `x:${SESSION}:r1:0`],
        ["QueuedPrompt", `x:${SESSION}:q1`],
        ["CommandOutput", `x:${SESSION}:o1`],
        ["Compaction", `x:${SESSION}:b1`],
        ["Unreadable", `x:${SESSION}:x1`],
      ]);
      expect(items[2]).toMatchObject({ text: "/status" });
      expect(items[5]).toMatchObject({
        output: [
          { stream: "stdout", text: "see </bash-stdout> here" },
          { stream: "stderr", text: "" },
        ],
        forkedFrom: { sessionId: "s0", messageUuid: "m0" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Rewrite inspection finding 10: every block of a line is an item, not only the first.
  it.effect("gives every block of a line its own item", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AA==" },
      };
      yield* fileSystem.writeFileString(
        filePath,
        jsonl([
          f.user("p1", null, [{ type: "text", text: "Look at this" }, image], {
            promptId: "pid-p1",
          }),
          f.blocks("a1", "p1", [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ]),
        ]),
      );
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });

      expect(itemsOf(yield* contentOf(filePath, tracker, "p1")).map((item) => item.id)).toEqual([
        `x:${SESSION}:p1:0`,
        `x:${SESSION}:p1:1`,
        `x:${SESSION}:a1:0`,
        `x:${SESSION}:a1:1`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Rewrite inspection finding 5: a live turn re-reads only its new or changed lines.
  it.effect("reads only the lines a caller does not hold, and names those that left the turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const start = jsonl([
        f.prompt("p1", null, "Go"),
        f.toolUse("a1", "p1", "t1"),
        f.command("c1", "a1", "status"),
      ]);
      yield* fileSystem.writeFileString(filePath, start);
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });
      const first = yield* contentOf(filePath, tracker, "p1");
      const known = new Map(first.lines.map((line) => [line.lineUuid, line.hash]));
      yield* fileSystem.writeFileString(filePath, start + jsonl([f.prompt("p2", "c1", "Next")]));
      const synced = yield* syncClaudeTranscript({ filePath, tracker });
      const second = yield* contentOf(filePath, tracker, "p1", known);

      expect(first.lines.map((line) => line.lineUuid)).toEqual(["p1", "a1", "c1"]);
      expect(synced.changedTurnIds.toSorted()).toEqual(["c1", "p1", "p2"]);
      expect(second).toMatchObject({ opener: undefined, lines: [], removedLineUuids: ["c1"] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Rewrite inspection 2 finding 3: a queued opener's prompt id changes while its bytes do not.
  it.effect("returns a queued opener again when its turn's prompt id changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const t = (seconds: number) => ({ timestamp: f.iso(seconds) });
      const lines = [
        f.prompt("p1", null, "Go", { ...t(1), promptId: "A" }),
        f.text("a1", "m", "Done", "end_turn", t(3)),
        f.queued("q", "a1", "Next", t(4)),
        f.text("a2", "q", "Ok", "end_turn", t(5)),
        f.meta("m", "p1", "B", "<task-notification>y</task-notification>", t(2)),
      ];
      const tracker = new ClaudeTranscriptTurnTracker();
      const known = new Map<string, Map<string, number>>();
      const prompts = new Map<string, string | undefined>();
      let text = "";
      for (const line of lines) {
        text += jsonl([line]);
        yield* fileSystem.writeFileString(filePath, text);
        const synced = yield* syncClaudeTranscript({ filePath, tracker });
        for (const id of synced.changedTurnIds) {
          const held = known.get(id) ?? new Map<string, number>();
          const content = yield* contentOf(filePath, tracker, id, held);
          if (content.opener !== undefined) prompts.set(id, content.opener.prompt?.promptId);
          for (const read of content.lines) held.set(read.lineUuid, read.hash);
          for (const gone of content.removedLineUuids) held.delete(gone);
          known.set(id, held);
        }
      }

      expect(tracker.turn("q")?.promptId).toBe("B");
      expect(prompts.get("q")).toBe("B");
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
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });

      expect((yield* contentOf(filePath, tracker, "a0")).opener).toEqual({
        prompt: undefined,
        forkedFrom: undefined,
      });
      expect((yield* contentOf(filePath, tracker, "q1")).opener?.prompt).toMatchObject({
        text: "Then this",
        promptId: "pid-p1",
        hidden: false,
      });
      const meta = yield* contentOf(filePath, tracker, "m1");
      expect(meta.opener?.prompt).toMatchObject({
        promptId: "pid-m1",
        originKind: "task-notification",
        hidden: true,
      });
      expect(itemsOf(meta).map((item) => item.lineUuid)).toEqual(["a3"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails rather than read another line where an indexed one was", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const f = claudeTranscriptFixture();
      const filePath = yield* transcriptFile;
      const text = jsonl([f.prompt("p1", null, "Hello"), f.text("a1", "p1", "Hi")]);
      yield* fileSystem.writeFileString(filePath, text);
      const tracker = new ClaudeTranscriptTurnTracker();
      yield* syncClaudeTranscript({ filePath, tracker });
      yield* fileSystem.writeFileString(filePath, text.replace("Hello", "Howdy"));

      const failure = yield* Effect.flip(contentOf(filePath, tracker, "p1"));

      expect(failure).toBeInstanceOf(ClaudeTranscriptChangedError);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
