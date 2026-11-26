import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readClaudeTranscriptTurn,
  type ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import { ClaudeTranscriptIndex, syncClaudeTranscriptIndex } from "./ClaudeTranscriptIndex.ts";
import {
  checkClaudeTranscriptTurns,
  type ClaudeTranscriptViolationKind,
} from "./ClaudeTranscriptInvariants.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import {
  claudeTranscriptStructure,
  type ClaudeTranscriptStructure,
} from "./ClaudeTranscriptTurns.ts";

interface Parsed {
  readonly lines: ReadonlyArray<string>;
  readonly structure: ClaudeTranscriptStructure;
  readonly contents: ReadonlyArray<ClaudeTranscriptTurnContent>;
}

const parse = (records: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = path.join(directory, "transcript.jsonl");
    const lines = records.map((record) => JSON.stringify(record));
    yield* fileSystem.writeFileString(filePath, lines.map((line) => `${line}\n`).join(""));
    const index = new ClaudeTranscriptIndex();
    yield* syncClaudeTranscriptIndex({ filePath, index });
    const structure = claudeTranscriptStructure(index);
    const contents: Array<ClaudeTranscriptTurnContent> = [];
    for (const turn of structure.turns) {
      contents.push(yield* readClaudeTranscriptTurn({ filePath, index, idScope: "s", turn }));
    }
    const parsed: Parsed = { lines, structure, contents };
    return parsed;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const kinds = (
  parsed: Parsed,
  change: (parsed: Parsed) => Partial<Parsed> & {
    others?: ReadonlyArray<{ name: string; structure: ClaudeTranscriptStructure }>;
  } = () => ({}),
) => {
  const changed = { ...parsed, others: [], ...change(parsed) };
  return [
    ...new Set(
      checkClaudeTranscriptTurns(changed).violations.map(
        (violation): ClaudeTranscriptViolationKind => violation.kind,
      ),
    ),
  ].toSorted();
};

// Moves the items of one line to another turn, as a parser that filed it there would give.
const refile = (parsed: Parsed, lineUuid: string, toTurn: string): Pick<Parsed, "contents"> => {
  const moved = parsed.contents.flatMap((content) =>
    content.items.filter((item) => item.lineUuid === lineUuid),
  );
  return {
    contents: parsed.contents.map((content) => ({
      ...content,
      items:
        content.turn.id === toTurn
          ? [...content.items.filter((item) => item.lineUuid !== lineUuid), ...moved]
          : content.items.filter((item) => item.lineUuid !== lineUuid),
    })),
  };
};

const withTurn = (
  parsed: Parsed,
  id: string,
  change: (
    turn: ClaudeTranscriptStructure["turns"][number],
  ) => ClaudeTranscriptStructure["turns"][number],
): Partial<Parsed> => {
  const turns = parsed.structure.turns.map((turn) => (turn.id === id ? change(turn) : turn));
  return {
    structure: { ...parsed.structure, turns },
    contents: parsed.contents.map((content) => ({
      ...content,
      turn: turns.find((turn) => turn.id === content.turn.id) ?? content.turn,
    })),
  };
};

const f = claudeTranscriptFixture();
const transcript = [
  f.prompt("p1", null, "First"),
  f.toolUse("a1", "p1", "t1", null),
  f.command("c1", "a1", "status"),
  f.result("r1", "a1", "t1"),
  f.queued("q1", "r1", "Also"),
  f.text("a2", "q1", "Done"),
  f.duration("d1", "a2", 1200),
  f.prompt("p2", "d1", "Second"),
  f.toolUse("b1", "p2", "t2"),
  f.prompt("p3", "b1", "Third"),
  f.result("b2", "b1", "t2"),
  f.boundary("k1", "b2"),
  f.summary("ks", "k1"),
  f.text("b3", "ks", "Carried on", null),
  f.interrupt("i3", "p3"),
  f.synthetic("s3", "i3"),
  f.command("c4", "s3", "cost"),
  f.commandOutput("o4", "c4", "Cost"),
  { ...f.text("x9", "p1", "Side"), isSidechain: true },
];

describe("checkClaudeTranscriptTurns", () => {
  it.effect("finds nothing wrong with the parser's turns for a transcript of every shape", () =>
    Effect.gen(function* () {
      const parsed = yield* parse(transcript);
      const result = checkClaudeTranscriptTurns({
        ...parsed,
        others: [{ name: "again", structure: parsed.structure }],
      });

      expect(result.violations).toEqual([]);
      expect(parsed.structure.turns.map((turn) => turn.id)).toEqual(["p1", "p2", "p3", "c4"]);
      expect(result.counts["repeated lines"]).toBeUndefined();
    }),
  );

  it.effect.each([
    [
      "content-line-missing",
      (parsed: Parsed) => ({
        contents: parsed.contents.map((content) => ({
          ...content,
          items: content.items.filter((item) => item.lineUuid !== "a2"),
        })),
      }),
    ],
    [
      "content-line-missing",
      (parsed: Parsed) => ({
        contents: parsed.contents.map((content) => ({
          ...content,
          items: content.items.filter((item) => item._tag !== "CommandOutput"),
        })),
      }),
    ],
    ["item-outside-its-chain", (parsed: Parsed) => refile(parsed, "a2", "p2")],
    ["item-outside-its-chain", (parsed: Parsed) => refile(parsed, "b3", "p3")],
    [
      "queued-filed-wrongly",
      (parsed: Parsed) => withTurn(parsed, "p1", (turn) => ({ ...turn, id: "q1" })),
    ],
    [
      "duration-not-kept",
      (parsed: Parsed) =>
        withTurn(parsed, "p1", (turn) => ({
          ...turn,
          end:
            turn.end === undefined
              ? undefined
              : { ...turn.end, reason: "turn-end", durationMs: undefined },
        })),
    ],
    [
      "interrupt-not-kept",
      (parsed: Parsed) =>
        withTurn(parsed, "p3", (turn) => ({
          ...turn,
          end: turn.end === undefined ? undefined : { ...turn.end, reason: "turn-end" },
        })),
    ],
    [
      "running-before-last",
      (parsed: Parsed) => withTurn(parsed, "p2", (turn) => ({ ...turn, end: undefined })),
    ],
    [
      "superseded-end-kept",
      (parsed: Parsed) =>
        withTurn(parsed, "p1", (turn) => ({
          ...turn,
          end: { reason: "next-prompt", at: turn.startedAt, durationMs: undefined },
        })),
    ],
    [
      "end-before-start",
      (parsed: Parsed) =>
        withTurn(parsed, "p2", (turn) => ({
          ...turn,
          end: turn.end === undefined ? undefined : { ...turn.end, at: "2025-01-01T00:00:00.000Z" },
        })),
    ],
    [
      "start-not-opener-time",
      (parsed: Parsed) =>
        withTurn(parsed, "p2", (turn) => ({ ...turn, startedAt: "2025-01-01T00:00:00.000Z" })),
    ],
    [
      "unreadable-but-readable",
      (parsed: Parsed) => ({
        contents: parsed.contents.map((content) => ({
          ...content,
          items: content.items.map((item) =>
            item.lineUuid === "a2"
              ? { _tag: "Unreadable" as const, id: item.id, lineUuid: item.lineUuid, offset: 0 }
              : item,
          ),
        })),
      }),
    ],
    [
      "raw-command-markup",
      (parsed: Parsed) => ({
        contents: parsed.contents.map((content) => ({
          ...content,
          items: content.items.map((item) =>
            item._tag === "CommandOutput"
              ? {
                  ...item,
                  output: [
                    {
                      stream: "stdout" as const,
                      text: "<local-command-stdout>Cost</local-command-stdout>",
                    },
                  ],
                }
              : item,
          ),
        })),
      }),
    ],
    [
      "raw-command-markup",
      (parsed: Parsed) => ({
        contents: parsed.contents.map((content) => ({
          ...content,
          items: content.items.map((item) =>
            item._tag === "Command"
              ? { ...item, text: "<command-name>/status</command-name>" }
              : item,
          ),
        })),
      }),
    ],
    [
      "differs-from-whole-read",
      (parsed: Parsed) => ({
        others: [
          {
            name: "split",
            structure: { ...parsed.structure, turns: parsed.structure.turns.slice(1) },
          },
        ],
      }),
    ],
  ] as const)("reports %s", ([kind, change]) =>
    Effect.gen(function* () {
      const parsed = yield* parse(transcript);

      expect(kinds(parsed, change)).toContain(kind);
    }),
  );

  // Round 5 finding 12: a parser that opens a turn for every user line, tool results included.
  it.effect("reports a turn opened at a tool result", () =>
    Effect.gen(function* () {
      const parsed = yield* parse(transcript);
      const turn = parsed.structure.turns[0];
      if (turn === undefined) return yield* Effect.die("No turn.");
      const opened = { ...turn, id: "r1", lineUuids: ["r1"], startedAt: turn.startedAt };
      const change = () => ({
        structure: { ...parsed.structure, turns: [...parsed.structure.turns, opened] },
        ...refile(
          {
            ...parsed,
            contents: [
              ...parsed.contents,
              { turn: opened, prompt: undefined, forkedFrom: undefined, items: [] },
            ],
          },
          "r1",
          "r1",
        ),
      });

      expect(kinds(parsed, change)).toContain("opened-without-cause");
    }),
  );

  // Round 5 finding 12: a parser that opens only the first prompt.
  it.effect("reports a typed prompt that opened no turn", () =>
    Effect.gen(function* () {
      const parsed = yield* parse(transcript);
      const merged = refile(parsed, "p2", "p1");
      const change = () => ({
        structure: {
          ...parsed.structure,
          turns: parsed.structure.turns.filter((turn) => turn.id !== "p2"),
        },
        contents: merged.contents.filter((content) => content.turn.id !== "p2"),
      });

      expect(kinds(parsed, change)).toContain("prompt-not-opened");
    }),
  );

  // Round 5 finding 17: shell output kept as raw markup.
  it.effect("reports shell output kept as a raw block", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const parsed = yield* parse([
        g.prompt("p1", null, "Run"),
        g.text("a1", "p1", "Ran"),
        g.user("o1", "a1", "<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>"),
      ]);
      const change = (current: Parsed) => ({
        contents: current.contents.map((content) => ({
          ...content,
          items: content.items.map((item) =>
            item._tag === "CommandOutput"
              ? {
                  _tag: "Block" as const,
                  id: item.id,
                  lineUuid: item.lineUuid,
                  timestamp: item.timestamp,
                  forkedFrom: undefined,
                  blockIndex: undefined,
                  role: "user" as const,
                  block: { type: "text" as const, text: "<bash-stdout>out</bash-stdout>" },
                  model: undefined,
                  messageId: undefined,
                }
              : item,
          ),
        })),
      });

      expect(kinds(parsed)).toEqual([]);
      expect(kinds(parsed, change)).toEqual(["raw-command-markup"]);
    }),
  );

  // Round 5 finding 23: copies are counted, and sidechain lines are not copies.
  it.effect("counts a replayed line as a repeat and a sidechain line as nothing", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const reply = g.text("a1", "p1", "Ok");
      const parsed = yield* parse([
        g.prompt("p1", null, "Go"),
        reply,
        { ...g.text("s1", "p1", "Side"), isSidechain: true },
        reply,
      ]);
      const result = checkClaudeTranscriptTurns({ ...parsed, others: [] });

      expect(result.violations).toEqual([]);
      expect(result.counts["repeated lines"]).toBe(1);
    }),
  );
});
