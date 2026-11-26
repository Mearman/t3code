import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ClaudeTranscriptCursor,
  claudeTranscriptSessionId,
  initialClaudeTranscriptCursor,
  readClaudeTranscript,
} from "./ClaudeTranscriptReader.ts";
import type { ClaudeTranscriptEvent } from "./ClaudeTranscriptSegments.ts";

const SESSION = "00000000-0000-4000-8000-000000000002";
// The cursor is stored between reads, so every resume goes through its stored form.
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(ClaudeTranscriptCursor));
const decodeCursor = Schema.decodeSync(Schema.fromJsonString(ClaudeTranscriptCursor));
const stored = (cursor: ClaudeTranscriptCursor) => decodeCursor(encodeCursor(cursor));

const BUDGET = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

const prompt = (uuid: string, parentUuid: string | null, content: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: SESSION,
    promptId: `prompt-${uuid}`,
    message: { role: "user", content },
  }) + "\n";

const reply = (uuid: string, parentUuid: string, content: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: SESSION,
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
    },
  }) + "\n";

const startedIds = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.flatMap((event) => (event._tag === "SegmentStarted" ? [event.segmentId] : []));

const itemTexts = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.flatMap((event) =>
    event._tag === "Item" && event.item.block.type === "text" ? [event.item.block.text] : [],
  );

const transcriptFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  return path.join(directory, `${SESSION}.jsonl`);
});

const read = (filePath: string, cursor = initialClaudeTranscriptCursor, maxBytes = BUDGET) =>
  readClaudeTranscript({ filePath, sessionId: SESSION, cursor: stored(cursor), maxBytes });

it.layer(NodeServices.layer)("readClaudeTranscript", (it) => {
  it.effect("leaves an unterminated last line for the next read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const first = prompt("p1", null, "First");
      const second = prompt("p2", "p1", "Second");
      yield* fileSystem.writeFileString(filePath, first + second.slice(0, 20));

      const initial = yield* read(filePath);
      expect(startedIds(initial.events)).toEqual(["p1"]);
      expect(initial.cursor.offset).toBe(bytes(first));
      expect(initial.atEnd).toBe(true);

      yield* fileSystem.writeFileString(filePath, second.slice(20), { flag: "a" });
      const next = yield* read(filePath, initial.cursor);
      expect(next.rewritten).toBe(false);
      expect(startedIds(next.events)).toEqual(["p2"]);
    }),
  );

  it.effect("gives the same events however the file grows between reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const content = [
        prompt("p1", null, "Grüße 🙂 first"),
        reply("a1", "p1", "Answer"),
        "{not json}\n",
        prompt("p2", "a1", "Second ✓"),
        reply("a2", "p2", "Answer again"),
      ].join("");
      const whole = encoder.encode(content);
      yield* fileSystem.writeFile(filePath, whole);
      const once = yield* read(filePath);

      // Cut the file at every line edge, a byte either side, and inside multi-byte characters.
      const cuts = new Set<number>();
      whole.forEach((byte, index) => {
        if (byte !== 0x0a && (byte & 0xc0) !== 0x80) return;
        for (const cut of [index - 1, index, index + 1, index + 2]) {
          if (cut > 0 && cut < whole.length) cuts.add(cut);
        }
      });
      for (const cut of [...cuts].toSorted((left, right) => left - right)) {
        yield* fileSystem.writeFile(filePath, whole.subarray(0, cut));
        const head = yield* read(filePath);
        yield* fileSystem.writeFile(filePath, whole);
        const rest = yield* read(filePath, head.cursor);
        expect(rest.rewritten, `cut at ${cut}`).toBe(false);
        expect([...head.events, ...rest.events], `cut at ${cut}`).toEqual(once.events);
        expect([...head.malformed, ...rest.malformed].map((error) => error.offset)).toEqual(
          once.malformed.map((error) => error.offset),
        );
        expect(rest.cursor).toEqual(once.cursor);
      }
      expect(once.cursor.offset).toBe(whole.length);
      expect(once.malformed.map((error) => error.offset)).toEqual([
        bytes(prompt("p1", null, "Grüße 🙂 first") + reply("a1", "p1", "Answer")),
      ]);
      expect(startedIds(once.events)).toEqual(["p1", "p2"]);
    }),
  );

  it.effect("reads a line that spans several chunks whole", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const long = "é".repeat(400 * 1024);
      const content =
        prompt("p1", null, "Short") + reply("a1", "p1", long) + reply("a2", "a1", "Tail");
      yield* fileSystem.writeFileString(filePath, content);

      const result = yield* read(filePath);

      expect(itemTexts(result.events)).toEqual(["Short", long, "Tail"]);
      expect(result.cursor.offset).toBe(bytes(content));
    }),
  );

  it.effect("starts again from the top when the last line read changed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const first = prompt("p1", null, "First");
      yield* fileSystem.writeFileString(filePath, first + reply("a1", "p1", "Same tail"));
      const initial = yield* read(filePath);

      // The same length and the same last bytes: only the line's uuid differs.
      yield* fileSystem.writeFileString(filePath, first + reply("b1", "p1", "Same tail"));
      const next = yield* read(filePath, initial.cursor);

      expect(next.rewritten).toBe(true);
      expect(startedIds(next.events)).toEqual(["p1"]);
      expect(itemTexts(next.events)).toEqual(["First", "Same tail"]);
    }),
  );

  it.effect.each([
    [
      "an earlier line, the last one unchanged",
      (first: string) => first + reply("a1", "p1", "Middle") + prompt("p9", "a1", "Same last line"),
    ],
    ["the line before a blank last line", (first: string) => first + "\n"],
  ] as const)("starts again from the top when %s is rewritten in place", ([_name, build]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      yield* fileSystem.writeFileString(filePath, build(prompt("p1", null, "First")));
      const initial = yield* read(filePath);

      // Same length, so only the bytes themselves show the change.
      yield* fileSystem.writeFileString(
        filePath,
        build(prompt("q1", null, "Other")) + prompt("p2", "p9", "Appended"),
      );
      const next = yield* read(filePath, initial.cursor);

      expect(next.rewritten).toBe(true);
      expect(startedIds(next.events)[0]).toBe("q1");
    }),
  );

  it.effect("resumes when only bytes after the cursor changed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const first = prompt("p1", null, "First");
      yield* fileSystem.writeFileString(filePath, first + '{"partial":');
      const initial = yield* read(filePath);

      yield* fileSystem.writeFileString(filePath, first + prompt("p2", "p1", "Second"));
      const next = yield* read(filePath, initial.cursor);

      expect(next.rewritten).toBe(false);
      expect(startedIds(next.events)).toEqual(["p2"]);
    }),
  );

  it.effect.each([
    ["the start", 100],
    ["the end", -100],
  ] as const)("detects a change near %s of a long last line", ([_name, position]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const content = prompt("p1", null, "x".repeat(300 * 1024));
      yield* fileSystem.writeFileString(filePath, content);
      const initial = yield* read(filePath);

      const changed = encoder.encode(content);
      const at = position >= 0 ? position : changed.length + position;
      changed[at] = changed[at] === 0x78 ? 0x79 : 0x5a;
      yield* fileSystem.writeFile(filePath, changed);
      const next = yield* read(filePath, initial.cursor);

      expect(next.rewritten).toBe(true);
    }),
  );

  it.effect("starts again from the top for a replaced or shortened file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const content = prompt("p1", null, "First") + prompt("p2", "p1", "Second");
      yield* fileSystem.writeFileString(filePath, content);
      const initial = yield* read(filePath);

      const replacement = `${filePath}.tmp`;
      yield* fileSystem.writeFileString(replacement, content);
      yield* fileSystem.rename(replacement, filePath);
      const replaced = yield* read(filePath, initial.cursor);
      expect(replaced.rewritten).toBe(true);
      expect(startedIds(replaced.events)).toEqual(["p1", "p2"]);

      yield* fileSystem.truncate(filePath, bytes(prompt("p1", null, "First")));
      const shortened = yield* read(filePath, replaced.cursor);
      expect(shortened.rewritten).toBe(true);
      expect(startedIds(shortened.events)).toEqual(["p1"]);
    }),
  );

  it.effect("stops after the byte budget and resumes where it stopped", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const filler = "y".repeat(300 * 1024);
      const content =
        prompt("p1", null, filler) + prompt("p2", "p1", filler) + prompt("p3", "p2", "End");
      yield* fileSystem.writeFileString(filePath, content);

      const first = yield* read(filePath, initialClaudeTranscriptCursor, 1);
      expect(first.atEnd).toBe(false);
      expect(first.cursor.offset).toBeLessThan(bytes(content));

      const rest = yield* read(filePath, first.cursor);
      expect(rest.rewritten).toBe(false);
      expect(rest.atEnd).toBe(true);
      expect(startedIds([...first.events, ...rest.events])).toEqual(["p1", "p2", "p3"]);
      expect(rest.cursor.offset).toBe(bytes(content));
    }),
  );

  it.effect("fails, without a cursor, when the file cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();

      const error = yield* Effect.flip(read(directory));

      expect(error._tag).toBe("PlatformError");
    }),
  );
});

describe("claudeTranscriptSessionId", () => {
  it.each([
    [`${SESSION}.jsonl`, SESSION],
    [`${SESSION}.jsonl.superseded-1700000000000`, undefined],
    [`${SESSION}.jsonl.orphaned`, undefined],
    [`${SESSION}.superseded-1700000000000`, undefined],
    ["agent-a1b2c3.jsonl", undefined],
  ])("reads %s as %s", (fileName, sessionId) => {
    expect(claudeTranscriptSessionId(fileName)).toBe(sessionId);
  });
});
