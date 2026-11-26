import { describe, expect, it } from "@effect/vitest";

import {
  claudeTranscriptFixture,
  expectTrackerFollows,
  indexClaudeTranscriptLines,
} from "./ClaudeTranscriptTestLines.ts";
import { ClaudeTranscriptTurnTracker } from "./ClaudeTranscriptTurnTracker.ts";
import { claudeTranscriptStructure } from "./ClaudeTranscriptTurns.ts";

// A small deterministic generator, so a failing case is reproduced from its seed.
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % Math.max(1, bound);
  };
}

type Line = Record<string, unknown>;

/** A transcript of every line shape, with parents written late, absent, looping and replayed. */
function randomTranscript(seed: number, length: number): Array<Line | string> {
  const next = random(seed);
  const f = claudeTranscriptFixture();
  const uuids = Array.from({ length }, (_, index) => `u${index.toString().padStart(3, "0")}`);
  const parentFor = (index: number): string | null => {
    const roll = next(100);
    if (roll < 6 || index === 0) return null;
    if (roll < 12) return `gone-${next(3)}`;
    if (roll < 24) return uuids[Math.min(length - 1, index + 1 + next(4))] ?? null;
    return uuids[Math.max(0, index - 1 - next(Math.min(index, 6)))] ?? null;
  };
  const lines: Array<Line | string> = [];
  for (let index = 0; index < length; index++) {
    const uuid = uuids[index] ?? "";
    const parent = parentFor(index);
    const timestamp = f.iso(next(40));
    const promptId = `pid-${next(5)}`;
    const tool = `t${next(4)}`;
    const extra = { timestamp };
    const shape = next(18);
    const line: Line =
      shape === 0
        ? f.prompt(uuid, parent, `Prompt ${index}`, { ...extra, promptId })
        : shape === 1
          ? f.meta(uuid, parent, promptId, "<task-notification>Done</task-notification>", extra)
          : shape === 2
            ? f.queued(uuid, parent, "Queued", extra)
            : shape === 3
              ? f.command(uuid, parent, "status", extra)
              : shape === 4
                ? f.commandOutput(uuid, parent, "Output", extra)
                : shape === 5
                  ? f.text(uuid, parent, "Reply", "end_turn", extra)
                  : shape === 6
                    ? f.text(uuid, parent, "Partial", null, extra)
                    : shape === 7
                      ? f.toolUse(uuid, parent, tool, next(2) === 0 ? "tool_use" : null, extra)
                      : shape === 8
                        ? f.result(uuid, parent, tool, { ...extra, promptId })
                        : shape === 9
                          ? f.interrupt(uuid, parent, extra)
                          : shape === 10
                            ? f.synthetic(uuid, parent, extra)
                            : shape === 11
                              ? f.duration(uuid, parent, 100 + next(900), extra)
                              : shape === 12
                                ? f.boundary(uuid, parent, extra)
                                : shape === 13
                                  ? f.summary(uuid, parent, { ...extra, promptId })
                                  : shape === 14
                                    ? f.attachment(uuid, parent, extra)
                                    : shape === 15
                                      ? f.user(uuid, parent, [{ type: "tool_result" }], extra)
                                      : shape === 16
                                        ? f.thinking(uuid, parent, extra)
                                        : f.user(
                                            uuid,
                                            parent,
                                            "<command-name>/status</command-name>",
                                            {
                                              ...extra,
                                              promptId,
                                            },
                                          );
    lines.push(line);
    const extraRoll = next(20);
    if (extraRoll === 0) lines.push("not json");
    if (extraRoll === 1 && shape === 15) lines.push(f.result(uuid, parent, tool, extra));
    if (extraRoll === 2) {
      const replayed = lines[next(lines.length)];
      if (replayed !== undefined) lines.push(replayed);
    }
    if (extraRoll === 3)
      lines.push({ ...f.text(`side-${index}`, uuid, "Side"), isSidechain: true });
    if (extraRoll === 4) lines.push({ type: "ai-title", aiTitle: `Title ${index}` });
  }
  return lines;
}

function permute<T>(lines: ReadonlyArray<T>, next: (bound: number) => number): Array<T> {
  const key = (line: T) =>
    typeof line === "object" && line !== null ? Reflect.get(line, "uuid") : undefined;
  const seen = new Set<unknown>();
  const firsts: Array<T> = [];
  const copies: Array<T> = [];
  for (const line of lines) {
    const uuid = key(line);
    if (uuid !== undefined && seen.has(uuid)) copies.push(line);
    else firsts.push(line);
    if (uuid !== undefined) seen.add(uuid);
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

const SEEDS = 150;

describe("ClaudeTranscriptTurnTracker", () => {
  it("equals the definition after every append of random transcripts, in any order and grouping", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const lines = randomTranscript(seed, 24 + (seed % 17));
      const next = random(seed * 7919);
      const expected = JSON.stringify(
        claudeTranscriptStructure(indexClaudeTranscriptLines(lines)).turns,
      );
      expectTrackerFollows(lines, `seed ${seed}`);
      for (let round = 0; round < 2; round++) {
        const shuffled = permute(lines, next);
        expect(
          JSON.stringify(claudeTranscriptStructure(indexClaudeTranscriptLines(shuffled)).turns),
          `seed ${seed} permutation ${round}`,
        ).toBe(expected);
        expectTrackerFollows(shuffled, `seed ${seed} permutation ${round}`, [
          1 + next(4),
          1 + next(6),
        ]);
      }
    }
  });

  // Rewrite inspection finding 6: the two inputs whose turns appeared and vanished between syncs.
  it("keeps a turn's identity while a parent or a tool result is outstanding", () => {
    const f = claudeTranscriptFixture();
    const parent = expectTrackerFollows(
      [f.prompt("p1", null, "Go"), f.toolUse("call", "think", "t1"), f.thinking("think", "p1")],
      "reply before its parent",
    );
    const tool = expectTrackerFollows(
      [
        f.prompt("p2", null, "Go"),
        f.toolUse("a2", "p2", "t2"),
        f.command("c2", "a2", "status"),
        f.result("r2", "a2", "t2"),
      ],
      "command while a tool runs",
    );

    expect(parent.turnIds()).toEqual(["p1"]);
    expect(tool.turnIds()).toEqual(["p2"]);
  });

  it("reports a turn that went away, as when a line filed by time finds an earlier turn", () => {
    const f = claudeTranscriptFixture();
    const tracker = new ClaudeTranscriptTurnTracker();
    const encoder = new TextEncoder();
    let offset = 0;
    const append = (line: unknown) => {
      const bytes = encoder.encode(JSON.stringify(line));
      tracker.index.addLine(bytes, offset);
      offset += bytes.length + 1;
      return tracker.update();
    };
    append(f.text("a0", "gone", "Mid-turn", null, { timestamp: f.iso(10) }));
    const absorbed = append(f.prompt("p0", null, "Go", { timestamp: f.iso(5) }));

    expect(absorbed.removedTurnIds).toEqual(["a0"]);
    expect(absorbed.changedTurnIds).toEqual(["p0"]);
    expect(tracker.turn("p0")?.lineUuids).toEqual(["p0", "a0"]);
  });

  // Rewrite inspection finding 4: an append's work is what it changes, not the session's size.
  it("decides only the lines an append touches, however long the session", () => {
    const f = claudeTranscriptFixture();
    const turn = (index: number, previous: string | null) => [
      f.prompt(`p${index}`, previous, `Prompt ${index}`),
      f.thinking(`k${index}`, `p${index}`),
      f.toolUse(`c${index}`, `k${index}`, `t${index}`),
      f.result(`r${index}`, `c${index}`, `t${index}`),
      f.text(`a${index}`, `r${index}`, "Done"),
      f.duration(`d${index}`, `a${index}`, 900),
    ];
    const lines = Array.from({ length: 2000 }, (_, index) =>
      turn(index, index === 0 ? null : `d${index - 1}`),
    ).flat();
    const tracker = new ClaudeTranscriptTurnTracker();
    const encoder = new TextEncoder();
    let offset = 0;
    const append = (line: unknown) => {
      const bytes = encoder.encode(JSON.stringify(line));
      tracker.index.addLine(bytes, offset);
      offset += bytes.length + 1;
    };
    for (const line of lines) append(line);
    tracker.update();
    const work = turn(2000, "d1999").map((line) => {
      append(line);
      return tracker.update();
    });
    const late = [
      f.toolUse("c2001", "k2001", "t2001"),
      f.result("r2001", "c2001", "t2001"),
      f.thinking("k2001", "p2000"),
    ];
    const lateWork = late.map((line) => {
      append(line);
      return tracker.update();
    });

    expect(Math.max(...work.map((update) => update.decided))).toBeLessThanOrEqual(3);
    expect(Math.max(...work.map((update) => update.digested))).toBeLessThanOrEqual(2);
    expect(Math.max(...lateWork.map((update) => update.decided))).toBeLessThanOrEqual(4);
    expect(tracker.structure()).toEqual(claudeTranscriptStructure(tracker.index));
  });

  it("rebuilds after a parent loop closes through earlier lines, and after a line is replaced", () => {
    const f = claudeTranscriptFixture();
    const loop = expectTrackerFollows(
      [
        f.prompt("p0", null, "Go"),
        f.text("x", "y", "One", null),
        f.text("z", "x", "Two", null),
        f.text("y", "z", "Three", null),
      ],
      "loop",
    );
    const replaced = expectTrackerFollows(
      [
        f.prompt("p1", null, "Go"),
        f.user("r1", "p1", [{ type: "tool_result" }]),
        f.result("r1", "p1", "t1"),
      ],
      "replaced",
    );

    expect(loop.turnIds()).toEqual(["p0", "x"]);
    expect(replaced.turnIds()).toEqual(["p1"]);
  });
});
