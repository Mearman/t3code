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
// The cursor is persisted between reads, so the test resumes from its stored form.
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(ClaudeTranscriptCursor));
const decodeCursor = Schema.decodeSync(Schema.fromJsonString(ClaudeTranscriptCursor));

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

const startedIds = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.flatMap((event) => (event._tag === "SegmentStarted" ? [event.segmentId] : []));

const transcriptFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  return path.join(directory, `${SESSION}.jsonl`);
});

it.layer(NodeServices.layer)("readClaudeTranscript", (it) => {
  it.effect("leaves an unterminated last line for the next read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const second = prompt("p2", "p1", "Second");
      yield* fileSystem.writeFileString(
        filePath,
        prompt("p1", null, "First") + second.slice(0, 20),
      );

      const first = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: initialClaudeTranscriptCursor,
        maxBytes: 1024 * 1024,
      });
      expect(startedIds(first.events)).toEqual(["p1"]);
      expect(first.cursor.offset).toBe(prompt("p1", null, "First").length);
      expect(first.atEnd).toBe(true);

      yield* fileSystem.writeFileString(filePath, second.slice(20), { flag: "a" });
      const next = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: decodeCursor(encodeCursor(first.cursor)),
        maxBytes: 1024 * 1024,
      });
      expect(next.rewritten).toBe(false);
      expect(startedIds(next.events)).toEqual(["p2"]);
      expect(next.events).toContainEqual(
        expect.objectContaining({ _tag: "SegmentEnded", segmentId: "p1", reason: "next-prompt" }),
      );
    }),
  );

  it.effect("starts again from the top when the bytes before the cursor change", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      yield* fileSystem.writeFileString(filePath, prompt("p1", null, "First"));
      const first = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: initialClaudeTranscriptCursor,
        maxBytes: 1024 * 1024,
      });

      // The file only grew, so its size alone would let the read resume past changed bytes.
      yield* fileSystem.writeFileString(
        filePath,
        prompt("q1", null, "Other") + prompt("q2", "q1", "More"),
      );
      const next = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: first.cursor,
        maxBytes: 1024 * 1024,
      });

      expect(next.rewritten).toBe(true);
      expect(startedIds(next.events)).toEqual(["q1", "q2"]);
    }),
  );

  it.effect("stops after the byte budget and resumes where it stopped", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const filePath = yield* transcriptFile;
      const line = prompt("p1", null, "First");
      yield* fileSystem.writeFileString(filePath, line + prompt("p2", "p1", "Second"));

      // A budget below one chunk still consumes whole lines, so it is reached after the first read.
      const first = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: initialClaudeTranscriptCursor,
        maxBytes: 1,
      });
      expect(startedIds(first.events)).toEqual(["p1", "p2"]);
      expect(first.atEnd).toBe(false);

      const next = yield* readClaudeTranscript({
        filePath,
        sessionId: SESSION,
        cursor: first.cursor,
        maxBytes: 1,
      });
      expect(next.events).toEqual([]);
      expect(next.atEnd).toBe(true);
      expect(next.cursor).toEqual(first.cursor);
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
