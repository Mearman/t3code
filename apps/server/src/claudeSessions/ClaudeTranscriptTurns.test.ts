import { describe, expect, it } from "@effect/vitest";

import {
  claudeTranscriptFixture,
  expectTrackerFollows,
  indexClaudeTranscriptLines,
} from "./ClaudeTranscriptTestLines.ts";
import {
  claudeTranscriptStructure,
  type ClaudeTranscriptStructure,
} from "./ClaudeTranscriptTurns.ts";

type Line = Record<string, unknown>;

// A small deterministic generator, so a failing permutation is reproduced from its seed.
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % Math.max(1, bound);
  };
}

// Shuffles the first line of each uuid and the lines without one; later copies follow in order.
function permute(lines: ReadonlyArray<Line>, next: (bound: number) => number): Array<Line> {
  const seen = new Set<unknown>();
  const firsts: Array<Line> = [];
  const copies: Array<Line> = [];
  for (const line of lines) {
    if (line.uuid !== undefined && seen.has(line.uuid)) copies.push(line);
    else firsts.push(line);
    seen.add(line.uuid);
  }
  for (let index = firsts.length - 1; index > 0; index--) {
    const other = next(index + 1);
    const [left, right] = [firsts[index], firsts[other]];
    if (left === undefined || right === undefined) continue;
    firsts[index] = right;
    firsts[other] = left;
  }
  return [...firsts, ...copies];
}

const PERMUTATIONS = 64;
// Following every append re-derives the whole structure each time, so long fixtures follow fewer orders.
const FOLLOWED_ORDERS = 8;
const FOLLOWED_LINES = 100;

/**
 * The structure of these lines, after checking the properties every structure must have: any order that keeps each uuid's first line before its copies gives the same turns, and the tracker fed those lines one at a time equals the definition after every append.
 */
function structureOf(lines: ReadonlyArray<Line>): ClaudeTranscriptStructure {
  const structure = claudeTranscriptStructure(indexClaudeTranscriptLines(lines));
  const expected = JSON.stringify(structure.turns);
  expectTrackerFollows(lines, "file order");
  for (let seed = 1; seed <= PERMUTATIONS; seed++) {
    const shuffled = permute(lines, random(seed));
    expect(
      JSON.stringify(claudeTranscriptStructure(indexClaudeTranscriptLines(shuffled)).turns),
      `permutation seed ${seed}`,
    ).toBe(expected);
    if (seed <= FOLLOWED_ORDERS && lines.length <= FOLLOWED_LINES) {
      expectTrackerFollows(shuffled, `permutation seed ${seed}`);
    }
  }
  return structure;
}

const turnIds = (structure: ClaudeTranscriptStructure) => structure.turns.map((turn) => turn.id);
const turnOf = (structure: ClaudeTranscriptStructure, uuid: string) =>
  structure.turns.find((turn) => turn.id === uuid || turn.lineUuids.includes(uuid))?.id;
const turn = (structure: ClaudeTranscriptStructure, id: string) => {
  const found = structure.turns.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No turn ${id}.`);
  return found;
};
const filing = (structure: ClaudeTranscriptStructure, uuids: ReadonlyArray<string>) =>
  Object.fromEntries(uuids.map((uuid) => [uuid, turnOf(structure, uuid)]));

describe("claudeTranscriptStructure", () => {
  it("opens a turn per prompt and files each reply by its chain", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "First"),
      f.toolUse("a1", "p1", "t1"),
      f.result("r1", "a1", "t1"),
      f.text("a2", "r1", "Done"),
      f.duration("d1", "a2", 1200),
      f.prompt("p2", "d1", "Second"),
      f.text("b1", "p2", "Also done"),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "p2"]);
    expect(turn(structure, "p1")).toMatchObject({
      opener: "prompt",
      promptId: "pid-p1",
      lineUuids: ["p1", "a1", "r1", "a2"],
      end: { reason: "turn-duration", durationMs: 1200 },
      lastAssistantUuid: "a2",
      branchedFrom: undefined,
    });
    expect(turn(structure, "p2").end).toMatchObject({ reason: "turn-end" });
  });

  it("leaves the last turn running and ends a superseded one by the next prompt", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "First"),
      f.toolUse("a1", "p1", "t1"),
      f.prompt("p2", "a1", "Second"),
      f.thinking("b1", "p2"),
    ]);

    expect(turn(structure, "p1").end?.reason).toBe("next-prompt");
    expect(turn(structure, "p2").end).toBeUndefined();
  });

  // Round 3 finding 1: reply lines stamped before a prompt typed while they streamed.
  it("keeps a reply written after a newer prompt, stamped before it, in the turn it continues", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Earlier"),
      f.text("a0", "p0", "Working", null),
      f.prompt("p1", "a0", "Now this", { timestamp: f.iso(24) }),
      f.attachment("h1", "p1", { timestamp: f.iso(24) }),
      f.thinking("r1", "a0", { timestamp: f.iso(21) }),
      f.text("r2", "r1", "Partial", null, { timestamp: f.iso(22) }),
      f.toolUse("r3", "r2", "t1", "tool_use", { timestamp: f.iso(25) }),
      f.result("r4", "r3", "t1", { timestamp: f.iso(26) }),
      f.interrupt("i1", "r4", { timestamp: f.iso(27) }),
    ]);

    expect(filing(structure, ["r1", "r2", "r3", "r4", "i1"])).toEqual({
      r1: "p0",
      r2: "p0",
      r3: "p0",
      r4: "p0",
      i1: "p0",
    });
    expect(turn(structure, "p0").end?.reason).toBe("interrupted");
    expect(turn(structure, "p1").lineUuids).toEqual(["p1"]);
  });

  // Round 3 finding 1, a lone late call: its result must find it.
  it("files a late tool call stamped before the newer prompt with its result", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Earlier"),
      f.text("a0", "p0", "Working", null),
      f.prompt("p1", "a0", "Next", { timestamp: f.iso(600) }),
      f.toolUse("c1", "a0", "t1", "tool_use", { timestamp: f.iso(300) }),
      f.result("c2", "c1", "t1", { timestamp: f.iso(601) }),
    ]);

    expect(filing(structure, ["c1", "c2"])).toEqual({ c1: "p0", c2: "p0" });
  });

  // Round 3 finding 2: a prompt whose parent is written after it, with an interrupt stamped earlier.
  it("keeps an interrupt written after a prompt that names it as parent", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Go"),
      f.text("a0", "p0", "Working", null),
      f.prompt("p1", "i0", "Stop and do this", { timestamp: f.iso(44.174) }),
      f.interrupt("i0", "a0", { timestamp: f.iso(44.152) }),
      f.text("a1", "p1", "Ok"),
    ]);

    expect(turn(structure, "p0")).toMatchObject({
      lineUuids: ["p0", "a0", "i0"],
      end: { reason: "interrupted" },
    });
    expect(turn(structure, "p1")).toMatchObject({
      lineUuids: ["p1", "a1"],
      branchedFrom: undefined,
    });
  });

  // Round 3 finding 3 and round 4 finding 17: the compaction's own lines are stamped before the prompt.
  it("keeps the typed /compact command and its output after a compaction", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Work"),
      f.text("a0", "p0", "Done"),
      f.boundary("b1", "a0", { timestamp: f.iso(53.028) }),
      f.prompt("s1", "o1", "Carry on", { timestamp: f.iso(53.11) }),
      f.summary("cs", "b1", { timestamp: f.iso(53.0) }),
      f.meta("cv", "cs", "pid-c1", "<local-command-caveat>Caveat</local-command-caveat>", {
        timestamp: f.iso(42.608),
      }),
      f.user(
        "c1",
        "cv",
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
        {
          promptId: "pid-c1",
          timestamp: f.iso(42.608),
        },
      ),
      f.user("o1", "c1", "<local-command-stdout>Compacted</local-command-stdout>", {
        promptId: "pid-c1",
        timestamp: f.iso(53.131),
      }),
    ]);

    expect(turnIds(structure)).toEqual(["p0", "c1", "s1"]);
    expect(turn(structure, "c1")).toMatchObject({ opener: "prompt", lineUuids: ["c1", "o1"] });
    expect(turn(structure, "p0").lineUuids).toEqual(["p0", "a0", "b1"]);
    for (const each of structure.turns) {
      if (each.end !== undefined)
        expect(Date.parse(each.end.at)).toBeGreaterThanOrEqual(Date.parse(each.startedAt));
    }
  });

  // Round 3 finding 4: a long turn whose opener and a tool call are written again.
  it("ignores lines written again however far back their first copy is", () => {
    const f = claudeTranscriptFixture();
    const opener = f.prompt("p1", null, "Long");
    const call = f.toolUse("t0", "p1", "tool-0");
    const lines: Array<Line> = [opener, call];
    for (let step = 1; step <= 600; step++)
      lines.push(f.result(`r${step}`, step === 1 ? "t0" : `r${step - 1}`, "tool-0"));
    const plain = claudeTranscriptStructure(indexClaudeTranscriptLines(lines));
    const replayed = structureOf([...lines, opener, call]);

    expect(replayed.turns).toEqual(plain.turns);
    expect(turnIds(replayed)).toEqual(["p1"]);
  });

  // Round 3 finding 5 and round 4 finding 4: a command after a turn that died without an end.
  it("opens a turn for a command typed after a turn that died waiting", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.command("c1", "p1", "status"),
      f.text("a2", "a1", "Dangling", null),
      f.command("c2", "a2", "cost"),
      f.prompt("p2", "c2", "Next"),
    ]);

    expect(turn(structure, "c1")).toMatchObject({
      opener: "command",
      end: { reason: "turn-end" },
      branchedFrom: undefined,
    });
    expect(turn(structure, "c2").opener).toBe("command");
    expect(turnOf(structure, "a2")).toBe("p1");
  });

  // Round 3 finding 5 and round 4 finding 4: a later prompt shows the call died, so the command opens.
  it("opens a turn for a command chained to a tool call that died without a result", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.command("c1", "a1", "status"),
      f.prompt("p2", "c1", "Next"),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "c1", "p2"]);
  });

  // Round 4 finding 3 with a command: the result written after a newer prompt brings the command back.
  it("files a command with its tool call once the call's result arrives after a newer prompt", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.command("c1", "a1", "status"),
      f.prompt("p2", "c1", "Next"),
      f.result("r1", "a1", "t1"),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "p2"]);
    expect(turn(structure, "p1").lineUuids).toEqual(["p1", "a1", "c1", "r1"]);
  });

  // Rewrite inspection finding 6: the command stays in the running turn whether or not the result comes.
  it("keeps a command chained to a waiting tool call in its turn until a later prompt", () => {
    const f = claudeTranscriptFixture();
    const waiting = [
      f.prompt("p2", null, "Go"),
      f.toolUse("a2", "p2", "t2"),
      f.command("c2", "a2", "status"),
    ];
    const before = structureOf(waiting);
    const after = structureOf([...waiting, f.result("r2", "a2", "t2")]);

    expect(turnIds(before)).toEqual(["p2"]);
    expect(turn(before, "p2").lineUuids).toEqual(["p2", "a2", "c2"]);
    expect(turnIds(after)).toEqual(["p2"]);
  });

  // Rewrite inspection finding 6: a reply written before its parent already sits in the turn it joins.
  it("files a line whose parent is not yet written with the turn running when it was stamped", () => {
    const f = claudeTranscriptFixture();
    const early = [f.prompt("p1", null, "Go"), f.toolUse("call", "think", "t1")];
    const before = structureOf(early);
    const after = structureOf([...early, f.thinking("think", "p1", { timestamp: f.iso(0.5) })]);

    expect(turnIds(before)).toEqual(["p1"]);
    expect(turn(before, "p1")).toMatchObject({ lineUuids: ["p1", "call"], end: undefined });
    expect(turnIds(after)).toEqual(["p1"]);
    expect(turn(after, "p1")).toMatchObject({ lineUuids: ["p1", "think", "call"], end: undefined });
  });

  // Rewrite inspection finding 2: an auto-compaction whose logical parent is not in the file.
  it("files a compaction whose logical parent is gone with the turn it interrupted", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Go"),
      f.text("a0", "p0", "Working", null),
      f.boundary("cb", "gone"),
      f.summary("s1", "cb", { promptId: "pid-p0" }),
      f.text("a1", "s1", "Continuing"),
    ]);

    expect(turnIds(structure)).toEqual(["p0"]);
    expect(turn(structure, "p0")).toMatchObject({
      lineUuids: ["p0", "a0", "cb", "a1"],
      end: { reason: "turn-end" },
    });
  });

  // Rewrite inspection 2 finding 2: a later compaction with a missing logical parent joins the turn running then.
  it("files a second compaction whose logical parent is gone with the turn running then", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Go"),
      f.text("a0", "p0", "Working", null),
      f.boundary("cb1", "gone-1"),
      f.summary("s1", "cb1", { promptId: "pid-p0" }),
      f.text("a1", "s1", "Continuing"),
      f.prompt("p2", "a1", "Next"),
      f.text("a2", "p2", "Working", null),
      f.boundary("cb2", "gone-2"),
      f.summary("s2", "cb2", { promptId: "pid-p2" }),
      f.text("a3", "s2", "Continuing"),
    ]);

    expect(turnIds(structure)).toEqual(["p0", "p2"]);
    expect(turn(structure, "p2").lineUuids).toEqual(["p2", "a2", "cb2", "a3"]);
    expect(turn(structure, "p0").end?.reason).toBe("turn-end");
  });

  it("files a compaction with the turn its summary's prompt id names over a later one", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Long job"),
      f.toolUse("a1", "p1", "t1", null),
      f.prompt("p2", "a1", "Meanwhile"),
      f.boundary("cb", "gone"),
      f.summary("s1", "cb", { promptId: "pid-p1" }),
      f.text("a2", "s1", "Back on the job"),
    ]);

    expect(turnOf(structure, "cb")).toBe("p1");
    expect(turnOf(structure, "a2")).toBe("p1");
  });

  // Rewrite inspection 3 finding 5: of two summaries, the earliest names the prompt id.
  it("files a compaction by its earliest summary's prompt id", () => {
    const f = claudeTranscriptFixture();
    const t = (seconds: number) => ({ timestamp: f.iso(seconds) });
    const structure = structureOf([
      f.prompt("p1", null, "Go", { ...t(1), promptId: "A" }),
      f.text("a1", "p1", "Done", null, t(2)),
      f.prompt("p2", "a1", "Next", { ...t(3), promptId: "B" }),
      f.text("a2", "p2", "Done", null, t(4)),
      f.boundary("cb", "gone", t(5)),
      f.summary("s2", "cb", { ...t(7), promptId: "B" }),
      f.summary("s1", "cb", { ...t(6), promptId: "A" }),
      f.text("a3", "s1", "More", "end_turn", t(8)),
    ]);

    expect(turnOf(structure, "cb")).toBe("p1");
    expect(turnOf(structure, "a3")).toBe("p1");
  });

  // Rewrite inspection 2 finding 1: a queued turn's prompt id changes when a meta line above opens late.
  it("follows a queued turn's prompt id to the lines below it at any depth", () => {
    const f = claudeTranscriptFixture();
    const t = (seconds: number) => ({ timestamp: f.iso(seconds) });
    const structure = structureOf([
      f.prompt("p1", null, "Go", { ...t(1), promptId: "A" }),
      f.meta("m", "p1", "B", "<task-notification>y</task-notification>", t(2)),
      f.result("r", "m", "t1", t(3)),
      f.text("a1", "r", "Done", "end_turn", t(4)),
      f.queued("q", "a1", "Next", t(5)),
      f.text("a2", "q", "Ok", "end_turn", t(6)),
      f.meta("m2", "a2", "A", "<task-notification>x</task-notification>", t(7)),
      f.text("a3", "m2", "Seen", "end_turn", t(8)),
      f.text("a4", "m", "Reply", "end_turn", t(9)),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "m", "q", "m2"]);
    expect(turn(structure, "q")).toMatchObject({
      opener: "queued",
      promptId: "B",
      lineUuids: ["q", "a2"],
    });
    expect(turn(structure, "m2").lineUuids).toEqual(["m2", "a3"]);
  });

  it("follows a queued root's prompt id when a turn at the same time arrives later", () => {
    const f = claudeTranscriptFixture();
    const t = (seconds: number) => ({ timestamp: f.iso(seconds) });
    const structure = structureOf([
      f.queued("q", "gone", "Next", t(5)),
      f.text("a2", "q", "Ok", "end_turn", t(6)),
      f.meta("m2", "a2", "A", "<task-notification>x</task-notification>", t(7)),
      f.text("a3", "m2", "Seen", "end_turn", t(8)),
      f.prompt("p1", null, "Go", { ...t(5), promptId: "A" }),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "q"]);
    expect(turn(structure, "q").lineUuids).toEqual(["q", "a2", "a3"]);
  });

  it("opens an orphan turn for a line filed by time before any turn has started", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.text("a0", "gone", "Before", null),
      f.prompt("p1", null, "Go", { timestamp: f.iso(30) }),
      f.text("a1", "gone2", "After", "end_turn", { timestamp: f.iso(40) }),
    ]);

    expect(turnIds(structure)).toEqual(["a0", "p1"]);
    expect(turnOf(structure, "a1")).toBe("p1");
  });

  // Rewrite inspection finding 3: a stop-hook continuation chained to the turn_duration line.
  it("keeps a reply chained to a turn_duration line in that turn", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.text("a1", "p1", "Done", null),
      f.duration("d1", "a1", 900),
      f.text("a2", "d1", "More", null),
    ]);

    expect(turn(structure, "p1")).toMatchObject({
      lineUuids: ["p1", "a1", "a2"],
      end: { reason: "turn-duration" },
    });
  });

  it("opens a turn for a prompt with no text that carries a new prompt id", () => {
    const f = claudeTranscriptFixture();
    const image = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ];
    const structure = structureOf([
      f.prompt("p1", null, "Look"),
      f.text("a1", "p1", "Seen"),
      f.user("p2", "a1", image, { promptId: "pid-p2" }),
      f.user("p3", "p2", image, { promptId: "pid-p2" }),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "p2"]);
    expect(turn(structure, "p2").lineUuids).toEqual(["p2", "p3"]);
  });

  it("orders lines stamped alike at the same depth by uuid", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.result("r2", "a1", "t2", { timestamp: f.iso(30) }),
      f.result("r1", "a1", "t1", { timestamp: f.iso(30) }),
    ]);

    expect(turn(structure, "p1").lineUuids).toEqual(["p1", "a1", "r1", "r2"]);
  });

  // Round 4 findings 1 and 4, round 5 finding 4: a command run while a tool runs belongs to the turn.
  it("keeps a command run while a tool call waits, whatever the call's stop reason", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1", null),
      f.command("c1", "a1", "status"),
      f.result("r1", "a1", "t1"),
      f.text("a2", "r1", "Done"),
    ]);

    expect(turnIds(structure)).toEqual(["p1"]);
    expect(turn(structure, "p1")).toMatchObject({
      lineUuids: ["p1", "a1", "c1", "r1", "a2"],
      end: { reason: "turn-end" },
    });
  });

  // Round 4 finding 1 and round 5 finding 4: a queued prompt delivered into a superseded running turn.
  it("delivers a queued prompt into the running turn its chain continues", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "First"),
      f.toolUse("a1", "p1", "t1", null),
      f.prompt("p2", "a1", "Second"),
      f.result("r1", "a1", "t1"),
      f.queued("q1", "r1", "Also"),
      f.text("a3", "q1", "Both done"),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "p2"]);
    expect(filing(structure, ["r1", "q1", "a3"])).toEqual({ r1: "p1", q1: "p1", a3: "p1" });
    expect(structure.turns.every((each) => each.branchedFrom === undefined)).toBe(true);
  });

  it("opens a turn for a queued prompt delivered after the turn ended", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "First"),
      f.text("a1", "p1", "Done"),
      f.queued("q1", "a1", "Then this"),
      f.text("a2", "q1", "Also done"),
    ]);

    expect(turn(structure, "q1")).toMatchObject({
      opener: "queued",
      promptId: "pid-p1",
      lineUuids: ["q1", "a2"],
    });
  });

  // Round 4 finding 2: Claude Code's own reply after an interrupt.
  it("keeps an interrupt as the end after Claude Code's synthetic reply", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.interrupt("i1", "a1"),
      f.synthetic("s1", "i1"),
    ]);

    expect(turn(structure, "p1").end?.reason).toBe("interrupted");
  });

  // Round 4 finding 3: a result written many prompts after its call.
  it("files a tool result with its call after any number of newer prompts", () => {
    const f = claudeTranscriptFixture();
    const lines: Array<Line> = [f.prompt("p0", null, "Start"), f.toolUse("a0", "p0", "t0")];
    for (let step = 1; step <= 16; step++) {
      lines.push(
        step % 2 === 0
          ? f.command(`c${step}`, step === 1 ? "a0" : `x${step - 1}`, "status")
          : f.prompt(`x${step}`, step === 1 ? "a0" : `c${step - 1}`, `Prompt ${step}`),
      );
    }
    lines.push(f.result("r0", "a0", "t0"));

    expect(turnOf(structureOf(lines), "r0")).toBe("p0");
  });

  // Round 4 finding 6 and round 5 finding 5: the duration survives output after it and an interrupt before it.
  it("keeps a turn's duration after later output and after an interrupt", () => {
    const f = claudeTranscriptFixture();
    const timed = structureOf([
      f.prompt("p1", null, "Go"),
      f.text("a1", "p1", "Done"),
      f.duration("d1", "a1", 1200),
      f.user("o1", "d1", "<local-command-stdout>Later</local-command-stdout>", {
        promptId: "pid-p1",
      }),
    ]);
    const interrupted = structureOf([
      f.prompt("q1", null, "Go"),
      f.text("b1", "q1", "Working", null),
      f.interrupt("i1", "b1"),
      f.duration("d2", "i1", 900),
    ]);

    expect(turn(timed, "p1").end).toMatchObject({ reason: "turn-duration", durationMs: 1200 });
    expect(turn(interrupted, "q1").end).toMatchObject({ reason: "interrupted", durationMs: 900 });
  });

  // Round 4 finding 7, round 5 finding 1 (meta variant) and finding 8.
  it("opens a meta line's turn when a reply descends from it through lines without content", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Start"),
      f.toolUse("a0", "p0", "t0"),
      f.prompt("p1", "a0", "Next"),
      f.text("a1", "p1", "Done"),
      f.meta("m", "h", "pid-m", "<task-notification>Finished</task-notification>"),
      f.attachment("h", "a0"),
      f.attachment("x", "m"),
      f.queued("q1", "a0", "Queued into p0"),
      f.text("r", "x", "Notified"),
    ]);

    expect(turn(structure, "m")).toMatchObject({
      opener: "meta",
      promptId: "pid-m",
      lineUuids: ["m", "r"],
    });
    expect(turnOf(structure, "q1")).toBe("p0");
  });

  // Round 4 finding 8: a meta line with no reply below it opens nothing.
  it("leaves a meta line with no reply below it in its parent's turn", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("pa", null, "A"),
      f.toolUse("a1", "pa", "t1"),
      f.prompt("pb", "a1", "B"),
      f.meta("m", "pb", "pid-x", "<system-reminder>Note</system-reminder>"),
      f.result("r1", "a1", "t1", { promptId: "pid-x" }),
    ]);

    expect(turnIds(structure)).toEqual(["pa", "pb"]);
    expect(turn(structure, "pb").promptId).toBe("pid-pb");
    expect(turnOf(structure, "r1")).toBe("pa");
  });

  // Round 4 finding 9 and round 5 finding 7: an unreadable first copy gives way to a good one.
  it("uses the first well-formed copy of a line whose earlier copy could not be read", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Start"),
      f.text("a0", "p0", "Done"),
      f.user("p1", "a0", [{ type: "text" }], { promptId: "pid-p1" }),
      f.prompt("p1", "a0", "Good copy"),
      f.text("a1", "p1", "Reply"),
    ]);

    expect(turn(structure, "p1")).toMatchObject({ opener: "prompt", lineUuids: ["p1", "a1"] });
  });

  // Round 4 finding 16: a prompt that rewinds to an older turn's end is a branch; the older chain goes on.
  it("reports a branch from an older turn and keeps that turn's later replies", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Start"),
      f.text("a0", "p0", "Done"),
      f.prompt("p1", "a0", "Middle"),
      f.toolUse("b1", "p1", "t1"),
      f.prompt("p2", "a0", "Rewound"),
      f.result("b2", "b1", "t1"),
      f.text("b3", "b2", "Still going"),
    ]);

    expect(turn(structure, "p2").branchedFrom).toBe("a0");
    expect(turn(structure, "p1").branchedFrom).toBeUndefined();
    expect(filing(structure, ["b2", "b3"])).toEqual({ b2: "p1", b3: "p1" });
  });

  // Round 5 finding 1: a prompt read before its parent opens its own turn and keeps its replies.
  it("keeps a prompt read before its parent as its own turn with every reply", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Go"),
      f.text("a0", "p0", "Working", null),
      f.prompt("p1", "i0", "Instead"),
      f.interrupt("i0", "a0"),
      f.toolUse("a1", "p1", "t1"),
      f.result("r1", "a1", "t1"),
      f.text("a2", "r1", "Done"),
      f.duration("d1", "a2", 500),
    ]);

    expect(turn(structure, "p0").end?.reason).toBe("interrupted");
    expect(turn(structure, "p1")).toMatchObject({
      lineUuids: ["p1", "a1", "r1", "a2"],
      end: { reason: "turn-duration" },
    });
  });

  // Round 5 finding 2: a result read before its call, and a reply read before its prompt.
  it("moves nothing by arrival order: results, calls and replies follow their chains", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Start"),
      f.toolUse("a0", "p0", "t0"),
      f.prompt("p1", "a0", "Next"),
      f.text("b1", "p1", "Ok", null),
      f.result("r", "c", "t1"),
      f.toolUse("c", "a0", "t1"),
      f.text("d", "r", "Continued"),
      f.text("e1", "p3", "Early reply"),
      f.prompt("p3", "b1", "Third"),
    ]);

    expect(filing(structure, ["r", "c", "d", "e1"])).toEqual({
      r: "p0",
      c: "p0",
      d: "p0",
      e1: "p3",
    });
    expect(turn(structure, "p3")).toMatchObject({
      lastAssistantUuid: "e1",
      end: { reason: "turn-end" },
    });
  });

  // Round 5 finding 3: a command chained to a meta caveat is no branch.
  it("reports no branch for a command whose parent is a meta caveat", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Go"),
      f.text("a1", "p1", "Done"),
      f.meta("m", "a1", "pid-p2", "<local-command-caveat>Caveat</local-command-caveat>"),
      f.meta("m2", "m", "pid-p2", "<local-command-caveat>Again</local-command-caveat>"),
      f.user("c", "m2", "<command-name>/status</command-name>", { promptId: "pid-p2" }),
    ]);

    expect(turnIds(structure)).toEqual(["p1", "c"]);
    expect(turn(structure, "c").branchedFrom).toBeUndefined();
  });

  // Round 5 finding 6: lines chained through lines read before their own parents.
  it("files a grandchild read before its parent under the prompt its chain reaches", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Start"),
      f.text("a0", "p0", "Done"),
      f.attachment("x2", "x1"),
      f.attachment("x1", "p1"),
      f.prompt("p1", "a0", "Next"),
      f.text("a1", "x2", "Reply"),
    ]);

    expect(turnOf(structure, "a1")).toBe("p1");
  });

  it("follows a compaction's logical parent, so the turn it interrupted goes on", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p1", null, "Long job"),
      f.toolUse("a1", "p1", "t1"),
      f.result("r1", "a1", "t1"),
      f.boundary("b1", "r1"),
      f.summary("cs", "b1"),
      f.text("a2", "cs", "Carrying on"),
    ]);

    expect(turnIds(structure)).toEqual(["p1"]);
    expect(turn(structure, "p1").lineUuids).toEqual(["p1", "a1", "r1", "b1", "a2"]);
  });

  it("opens an orphan turn for content whose parent is not in the file", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([f.text("a1", "gone", "Mid-turn"), f.result("r1", "a1", "t1")]);

    expect(turn(structure, "a1")).toMatchObject({
      opener: "orphan",
      parentUuid: "gone",
      lineUuids: ["a1", "r1"],
    });
  });

  it("records a command once when Claude Code writes it as a prompt and as a system line", () => {
    const f = claudeTranscriptFixture();
    const typed =
      "<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>";
    const structure = structureOf([
      f.user("c1", null, typed, { promptId: "pid-c1" }),
      f.command("c2", "c1", "status"),
      f.commandOutput("o1", "c2", "Fine"),
    ]);

    expect(turnIds(structure)).toEqual(["c1"]);
    expect(turn(structure, "c1").lineUuids).toEqual(["c1", "o1"]);
  });

  it("cuts a parent cycle at its least uuid", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([f.text("b", "a", "One"), f.text("a", "b", "Two")]);

    expect(turnIds(structure)).toEqual(["a"]);
    expect(turn(structure, "a").lineUuids).toEqual(["a", "b"]);
  });

  // Rewrite inspection finding 1: only the loop is cut, never the lines hanging below it.
  it("keeps the lines below a parent loop under the loop's cut", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.text("b", "a", "One"),
      f.toolUse("a", "b", "t1"),
      f.result("0", "a", "t1"),
      f.text("1", "0", "After"),
    ]);

    expect(turnIds(structure)).toEqual(["a"]);
    expect(turn(structure, "a").lineUuids.toSorted()).toEqual(["0", "1", "a", "b"]);
  });

  it("cuts a loop closed by a parent written last, through lines filed by time", () => {
    const f = claudeTranscriptFixture();
    const structure = structureOf([
      f.prompt("p0", null, "Go"),
      f.text("x", "y", "One", null),
      f.text("z", "x", "Two", null),
      f.text("y", "z", "Three", null),
    ]);

    expect(turnIds(structure)).toEqual(["p0", "x"]);
    expect(turn(structure, "x").lineUuids.toSorted()).toEqual(["x", "y", "z"]);
  });

  it("changes a turn's digest when its lines or end change, and only then", () => {
    const f = claudeTranscriptFixture();
    const base = [
      f.prompt("p1", null, "Go"),
      f.toolUse("a1", "p1", "t1"),
      f.prompt("p2", "a1", "Next"),
    ];
    const before = structureOf(base);
    const after = structureOf([...base, f.result("r1", "a1", "t1")]);

    expect(turn(after, "p1").digest).not.toBe(turn(before, "p1").digest);
    expect(turn(after, "p2").digest).toBe(turn(before, "p2").digest);
  });

  // Rewrite inspection finding 9: the digest covers each line's bytes, not only which lines there are.
  it("changes a turn's digest when an unreadable line is replaced by its good copy", () => {
    const f = claudeTranscriptFixture();
    const unreadable = f.user("r1", "a1", [{ type: "tool_result" }]);
    const base = [f.prompt("p1", null, "Go"), f.toolUse("a1", "p1", "t1"), unreadable];
    const before = structureOf(base);
    const after = structureOf([
      ...base,
      { ...f.result("r1", "a1", "t1"), timestamp: unreadable.timestamp },
    ]);

    expect(turn(after, "p1").lineUuids).toEqual(turn(before, "p1").lineUuids);
    expect(turn(after, "p1").digest).not.toBe(turn(before, "p1").digest);
  });

  it("takes the titles and derivation from the latest line, and the fork from the first turn", () => {
    const f = claudeTranscriptFixture();
    const structure = claudeTranscriptStructure(
      indexClaudeTranscriptLines([
        { type: "ai-title", aiTitle: "First" },
        { type: "custom-title", customTitle: "Mine" },
        f.prompt("p1", null, "Go", { forkedFrom: { sessionId: "s0", messageUuid: "m0" } }),
        { type: "ai-title", aiTitle: "Second" },
        { type: "custom-title", customTitle: "" },
        { type: "derived-from", sessions: [{ id: "s0", via: "fork" }] },
      ]),
    );

    expect(structure).toMatchObject({
      aiTitle: "Second",
      customTitle: undefined,
      derivedFrom: [{ sessionId: "s0", via: "fork" }],
      forkedFromSessionId: "s0",
    });
  });
});
