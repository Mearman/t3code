import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readClaudeTranscriptTurn,
  type ClaudeTranscriptItem,
  type ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import {
  checkClaudeTranscriptTurns,
  type ClaudeTranscriptViolationKind,
} from "./ClaudeTranscriptInvariants.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import {
  ClaudeTranscriptTurnTracker,
  syncClaudeTranscript,
} from "./ClaudeTranscriptTurnTracker.ts";
import {
  claudeTranscriptStructure,
  type ClaudeTranscriptStructure,
  type ClaudeTranscriptTurn,
} from "./ClaudeTranscriptTurns.ts";

interface Parsed {
  readonly lines: ReadonlyArray<string>;
  readonly structure: ClaudeTranscriptStructure;
  readonly contents: ReadonlyArray<ClaudeTranscriptTurnContent>;
}
type Change = Partial<Parsed> & {
  readonly others?: ReadonlyArray<{ name: string; structure: ClaudeTranscriptStructure }>;
};

const parse = (records: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = path.join(directory, "transcript.jsonl");
    const lines = records.map((record) => JSON.stringify(record));
    yield* fileSystem.writeFileString(filePath, lines.map((line) => `${line}\n`).join(""));
    const tracker = new ClaudeTranscriptTurnTracker();
    yield* syncClaudeTranscript({ filePath, tracker });
    const structure = claudeTranscriptStructure(tracker.index);
    const contents: Array<ClaudeTranscriptTurnContent> = [];
    for (const turn of structure.turns) {
      contents.push(
        yield* readClaudeTranscriptTurn({
          filePath,
          index: tracker.index,
          idScope: "s",
          turn,
          known: new Map(),
        }),
      );
    }
    const parsed: Parsed = { lines, structure, contents };
    return parsed;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const kinds = (parsed: Parsed, change: (parsed: Parsed) => Change = () => ({})) => {
  const changed = { ...parsed, others: [], ...change(parsed) };
  return [
    ...new Set(
      checkClaudeTranscriptTurns(changed).violations.map(
        (violation): ClaudeTranscriptViolationKind => violation.kind,
      ),
    ),
  ].toSorted();
};

const itemsOf = (content: ClaudeTranscriptTurnContent) =>
  content.lines.flatMap((line) => line.items);
// Regroups items into lines, as a parser that produced exactly these items would give.
const withItems = (
  content: ClaudeTranscriptTurnContent,
  items: ReadonlyArray<ClaudeTranscriptItem>,
): ClaudeTranscriptTurnContent => {
  const lines = new Map<string, Array<ClaudeTranscriptItem>>();
  for (const item of items) lines.set(item.lineUuid, [...(lines.get(item.lineUuid) ?? []), item]);
  return {
    ...content,
    lines: [...lines].map(([lineUuid, lineItems]) => ({ lineUuid, hash: 0, items: lineItems })),
  };
};
const editItems = (
  parsed: Parsed,
  edit: (
    items: ReadonlyArray<ClaudeTranscriptItem>,
    content: ClaudeTranscriptTurnContent,
  ) => ReadonlyArray<ClaudeTranscriptItem>,
): Change => ({
  contents: parsed.contents.map((content) => withItems(content, edit(itemsOf(content), content))),
});

// Moves the items of one line to another turn, as a parser that filed it there would give.
const refile = (parsed: Parsed, lineUuid: string, toTurn: string): Pick<Parsed, "contents"> => {
  const moved = parsed.contents.flatMap((content) =>
    itemsOf(content).filter((item) => item.lineUuid === lineUuid),
  );
  return {
    contents: parsed.contents.map((content) => {
      const kept = itemsOf(content).filter((item) => item.lineUuid !== lineUuid);
      return withItems(content, content.turn.id === toTurn ? [...kept, ...moved] : kept);
    }),
  };
};

const withTurn = (
  parsed: Parsed,
  id: string,
  change: (turn: ClaudeTranscriptTurn) => ClaudeTranscriptTurn,
): Change => {
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

  // Rewrite inspection findings 1, 2, 3 and 7: inputs where the parser is right must pass.
  it.effect.each([
    [
      "a reply chained to a turn_duration line",
      () => [
        f.prompt("q1", null, "Go"),
        f.text("e1", "q1", "Done", null),
        f.duration("e2", "e1", 900),
        f.text("e3", "e2", "More", null),
      ],
    ],
    [
      "a parent loop with lines below it",
      () => [
        f.text("b", "a", "One"),
        f.toolUse("a", "b", "t1"),
        f.result("0", "a", "t1"),
        f.text("1", "0", "After"),
      ],
    ],
    [
      "a compaction whose logical parent is gone",
      () => [
        f.prompt("q0", null, "Go"),
        f.text("g0", "q0", "x", null),
        f.boundary("cb", "gone"),
        f.summary("cs", "cb", { promptId: "pid-q0" }),
        f.text("g1", "cs", "Continuing"),
      ],
    ],
    [
      "a reply written before its parent",
      () => [f.prompt("q2", null, "Go"), f.toolUse("call", "think", "t1")],
    ],
    [
      "a command while a tool runs",
      () => [
        f.prompt("q3", null, "Go"),
        f.toolUse("h1", "q3", "t3"),
        f.command("h2", "h1", "status"),
      ],
    ],
  ] as const)("passes %s", ([, lines]) =>
    Effect.gen(function* () {
      const parsed = yield* parse(lines());

      expect(kinds(parsed)).toEqual([]);
    }),
  );

  it.effect("keeps the compaction item of a compaction whose logical parent is gone", () =>
    Effect.gen(function* () {
      const parsed = yield* parse([
        f.prompt("q0", null, "Go"),
        f.text("g0", "q0", "x", null),
        f.boundary("cb", "gone"),
        f.summary("cs", "cb", { promptId: "pid-q0" }),
        f.text("g1", "cs", "Continuing"),
      ]);

      expect(
        parsed.contents.flatMap((content) => itemsOf(content).map((item) => item._tag)),
      ).toContain("Compaction");
    }),
  );

  it.effect.each([
    [
      "content-line-missing",
      (parsed: Parsed) =>
        editItems(parsed, (items) => items.filter((item) => item.lineUuid !== "a2")),
    ],
    [
      "content-line-missing",
      (parsed: Parsed) =>
        editItems(parsed, (items) => items.filter((item) => item._tag !== "CommandOutput")),
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
      (parsed: Parsed) =>
        editItems(parsed, (items) =>
          items.map((item) =>
            item.lineUuid === "a2"
              ? { _tag: "Unreadable" as const, id: item.id, lineUuid: item.lineUuid, offset: 0 }
              : item,
          ),
        ),
    ],
    [
      "raw-command-markup",
      (parsed: Parsed) =>
        editItems(parsed, (items) =>
          items.map((item) =>
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
        ),
    ],
    [
      "raw-command-markup",
      (parsed: Parsed) =>
        editItems(parsed, (items) =>
          items.map((item) =>
            item._tag === "Command"
              ? { ...item, text: "<command-name>/status</command-name>" }
              : item,
          ),
        ),
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

  // Rewrite inspection 2 finding 2: filing a later compaction among true roots' turns only is wrong.
  it.effect("reports a compaction filed with a turn older than the one running then", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const parsed = yield* parse([
        g.prompt("p0", null, "Go"),
        g.text("a0", "p0", "Working", null),
        g.boundary("cb1", "gone-1"),
        g.summary("s1", "cb1", { promptId: "pid-p0" }),
        g.text("a1", "s1", "Continuing"),
        g.prompt("p2", "a1", "Next"),
        g.text("a2", "p2", "Working", null),
        g.boundary("cb2", "gone-2"),
        g.summary("s2", "cb2", { promptId: "pid-p2" }),
        g.text("a3", "s2", "Continuing"),
      ]);
      const backward = (current: Parsed) =>
        refile({ ...current, ...refile(current, "cb2", "p0") }, "a3", "p0");

      expect(kinds(parsed)).toEqual([]);
      expect(kinds(parsed, backward)).toContain("item-outside-its-chain");
    }),
  );

  it.effect("reports a compaction filed by time over the turn its summary's prompt id names", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const parsed = yield* parse([
        g.prompt("p1", null, "Long job"),
        g.toolUse("a1", "p1", "t1", null),
        g.prompt("p2", "a1", "Meanwhile"),
        g.boundary("cb", "gone"),
        g.summary("s1", "cb", { promptId: "pid-p1" }),
        g.text("a2", "s1", "Back on the job"),
      ]);
      const byTime = (current: Parsed) =>
        refile({ ...current, ...refile(current, "cb", "p2") }, "a2", "p2");

      expect(kinds(parsed)).toEqual([]);
      expect(kinds(parsed, byTime)).toContain("item-outside-its-chain");
    }),
  );

  // Rewrite inspection finding 10: a reader that keeps only a line's first block.
  it.effect("reports a line that lost blocks", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AA==" },
      };
      const parsed = yield* parse([
        g.user("p1", null, [{ type: "text", text: "Look" }, image], { promptId: "pid-p1" }),
        g.blocks("a1", "p1", [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ]),
      ]);
      const firstBlocks = (current: Parsed) =>
        editItems(current, (items) =>
          items.filter((item) => item._tag !== "Block" || (item.blockIndex ?? 0) === 0),
        );

      expect(kinds(parsed)).toEqual([]);
      expect(kinds(parsed, firstBlocks)).toEqual(["items-not-one-per-block"]);
    }),
  );

  it.effect("reports a command filed against a tool call that a later prompt shows died", () =>
    Effect.gen(function* () {
      const g = claudeTranscriptFixture();
      const parsed = yield* parse([
        g.prompt("p1", null, "Go"),
        g.toolUse("a1", "p1", "t1"),
        g.command("c1", "a1", "status"),
        g.prompt("p2", "c1", "Next"),
      ]);
      const folded = (current: Parsed) => {
        const merged = refile(current, "c1", "p1");
        return {
          structure: {
            ...current.structure,
            turns: current.structure.turns.filter((turn) => turn.id !== "c1"),
          },
          contents: merged.contents.filter((content) => content.turn.id !== "c1"),
        };
      };

      expect(kinds(parsed)).toEqual([]);
      expect(kinds(parsed, folded)).toContain("command-filed-wrongly");
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
              { turn: opened, opener: undefined, lines: [], removedLineUuids: [] },
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
      const change = (current: Parsed) =>
        editItems(current, (items) =>
          items.map((item) =>
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
        );

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
