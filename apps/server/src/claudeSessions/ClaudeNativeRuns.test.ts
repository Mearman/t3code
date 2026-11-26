import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import {
  claimClaudeOwnTurnByText,
  claudeNativeItemLineUuid,
  claudeNativeOrdinals,
  claudeNativeResultsNeedWholeTurn,
  claudeNativeRunIds,
  claudePromptTextKey,
  isClaudeOwnTurn,
  NATIVE_TOOL_TEXT_MAX_CHARS,
  newClaudeNativeTurnCache,
  planClaudeNativeTurn,
  planClaudeRemovedItems,
  REMOVED_TURN_ID,
  type ClaudeNativeTurnCache,
  type ClaudeOwnTurns,
  type StoredNativeItem,
} from "./ClaudeNativeRuns.ts";
import {
  MAX_RUN_ORDINAL,
  TURN_ITEM_POSITIONS_PER_RUN,
} from "../orchestration-v2/TurnItemPositionStore.ts";
import {
  readClaudeTranscriptTurn,
  type ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import {
  ClaudeTranscriptTurnTracker,
  syncClaudeTranscript,
} from "./ClaudeTranscriptTurnTracker.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const FALLBACK = DateTime.makeUnsafe("2025-12-31T00:00:00.000Z");

const target = {
  sessionId: SESSION,
  idScope: SESSION,
  threadId: ThreadId.make(`claude:${SESSION}`),
  providerThreadId: ProviderThreadId.make("provider-thread:claude"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default-model" },
  skipCopied: false,
};

const noOwnTurns: ClaudeOwnTurns = {
  promptUuids: new Set(),
  assistantUuids: new Set(),
  promptTexts: new Map(),
};

const jsonl = (lines: ReadonlyArray<unknown>) =>
  lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");

/** Writes the lines to a transcript file and reads it into a turn tracker, as the sync does. */
const transcript = (lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = path.join(directory, `${SESSION}.jsonl`);
    yield* fileSystem.writeFileString(filePath, jsonl(lines));
    const tracker = new ClaudeTranscriptTurnTracker();
    yield* syncClaudeTranscript({ filePath, tracker });
    const { index } = tracker;
    /** The turn's lines `cache` does not hold; a new cache reads the whole turn. */
    const contentOf = (turnId: string, cache: ClaudeNativeTurnCache = newClaudeNativeTurnCache()) =>
      Effect.gen(function* () {
        const turn = tracker.turn(turnId);
        if (turn === undefined) return yield* Effect.die(`No turn ${turnId}.`);
        return yield* readClaudeTranscriptTurn({
          filePath,
          index,
          idScope: SESSION,
          turn,
          known: cache.known,
        });
      });
    /** Appends lines, as a terminal does, and syncs the tracker. */
    const append = (more: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const existing = yield* fileSystem.readFileString(filePath);
        yield* fileSystem.writeFileString(filePath, existing + jsonl(more));
        return yield* syncClaudeTranscript({ filePath, tracker });
      });
    return { tracker, index, contentOf, append };
  });

let nextId = 0;
const planOf = (
  content: ClaudeTranscriptTurnContent,
  overrides: {
    readonly stored?: boolean;
    readonly storedItems?: ReadonlyMap<string, StoredNativeItem>;
    readonly ordinal?: number;
    readonly cache?: ClaudeNativeTurnCache;
  } = {},
) =>
  planClaudeNativeTurn({
    target,
    content,
    cache: overrides.cache ?? newClaudeNativeTurnCache(),
    ordinal: overrides.ordinal ?? 1,
    providerTurnOrdinal: overrides.ordinal ?? 1,
    stored: overrides.stored ?? false,
    storedItems: overrides.storedItems ?? new Map(),
    eventId: () => EventId.make(`event-${nextId++}`),
    modelSlug: (reported) => `slug:${reported}`,
    fallbackAt: FALLBACK,
  });

const types = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.map((event) =>
    event.type === "turn-item.updated" ? `${event.type}:${event.payload.type}` : event.type,
  );

const itemsOf = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : []));

/** What the projection holds of these items, as the next plan reads it. */
/** What the projection holds of these items, positioned as the position store places them in run `runOrdinal`'s range. */
const storedFrom = (items: ReadonlyArray<OrchestrationV2TurnItem>, runOrdinal = 1) =>
  new Map<string, StoredNativeItem>(
    items.map((item) => [
      item.id,
      {
        runId: item.runId,
        ordinal: runOrdinal * TURN_ITEM_POSITIONS_PER_RUN + item.ordinal,
        status: item.status,
      },
    ]),
  );

const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("planClaudeNativeTurn", () => {
  it.effect("writes a terminal turn as a finished run marked as read from the transcript", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Run the tests", { origin: { kind: "human" } }),
          f.toolUse("a1", "p1", "tool-1"),
          f.result("r1", "a1", "tool-1"),
          f.text("a2", "r1", "All tests pass."),
        ]);
        const plan = planOf(yield* contentOf("p1"));

        expect(types(plan.events)).toEqual([
          "run.created",
          "run-attempt.created",
          "node.updated",
          "provider-turn.updated",
          "message.updated",
          "turn-item.updated:user_message",
          "turn-item.updated:command_execution",
          "turn-item.updated:assistant_message",
          "message.updated",
        ]);
        const [created] = plan.events;
        expect(created?.type === "run.created" && created.payload).toMatchObject({
          id: claudeNativeRunIds(SESSION, "p1").runId,
          status: "completed",
          modelSelection: { model: "slug:claude-test" },
          nativeOrigin: {
            kind: "claude_transcript",
            nativeSessionId: SESSION,
            promptUuid: "p1",
            turnOrigin: "human",
          },
        });
        const turn = plan.events.find((event) => event.type === "provider-turn.updated");
        expect(turn?.type === "provider-turn.updated" && turn.payload.nativeTurnRef).toEqual({
          driver: "claudeAgent",
          nativeId: "a2",
          strength: "weak",
        });
        const items = itemsOf(plan.events);
        expect(items.map((item) => [item.id, item.ordinal, item.status])).toEqual([
          [`x:${SESSION}:p1`, 0, "completed"],
          [`x:${SESSION}:a1:0`, 1, "completed"],
          [`x:${SESSION}:a2:0`, 2, "completed"],
        ]);
        expect(items[0]).toMatchObject({ createdBy: "user", text: "Run the tests" });
        expect(items[1]).toMatchObject({ output: "done" });
      }),
    ),
  );

  it.effect("writes only the run again when every item is stored as it is", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.thinking("a1", "p1"),
          f.text("a2", "a1", "Hi"),
        ]);
        const content = yield* contentOf("p1");
        const first = planOf(content);
        const again = planOf(content, {
          stored: true,
          storedItems: storedFrom(itemsOf(first.events)),
        });

        expect(types(again.events)).toEqual([
          "run.updated",
          "run-attempt.updated",
          "node.updated",
          "provider-turn.updated",
        ]);
      }),
    ),
  );

  it.effect("writes an item again when its run's ordinal moved, so it follows the run", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.thinking("a1", "p1"),
          f.text("a2", "a1", "Hi"),
        ]);
        const content = yield* contentOf("p1");
        const first = planOf(content);
        // Stored in this run at ordinal 1's positions; the run now takes ordinal 2.
        const moved = planOf(content, {
          stored: true,
          ordinal: 2,
          storedItems: storedFrom(itemsOf(first.events), 1),
        });
        expect(
          itemsOf(moved.events)
            .map((item) => item.id)
            .toSorted(),
        ).toEqual(
          itemsOf(first.events)
            .map((item) => item.id)
            .toSorted(),
        );
      }),
    ),
  );

  it.effect("moves an item stored in another run to the run its line now belongs to", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.text("a1", "p1", "Hi"),
        ]);
        const content = yield* contentOf("p1");
        const elsewhere = claudeNativeRunIds(SESSION, "p0").runId;
        const plan = planOf(content, {
          stored: true,
          storedItems: new Map([
            [
              `x:${SESSION}:a1:0`,
              { runId: elsewhere, ordinal: TURN_ITEM_POSITIONS_PER_RUN + 1, status: "completed" },
            ],
          ]),
        });
        expect(itemsOf(plan.events).map((item) => [item.id, item.runId])).toContainEqual([
          `x:${SESSION}:a1:0`,
          claudeNativeRunIds(SESSION, "p1").runId,
        ]);
      }),
    ),
  );

  it.effect("completes a tool whose result line comes before its use in the file", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.result("r1", "a1", "tool-1"),
          f.toolUse("a1", "p1", "tool-1"),
          f.text("a2", "r1", "Done"),
        ]);
        const tool = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:a1:0`,
        );
        expect(tool).toMatchObject({ status: "completed", output: "done" });
      }),
    ),
  );

  it.effect("leaves a tool running in the last open turn, and interrupted in an ended one", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "First"),
          f.toolUse("a1", "p1", "tool-1"),
          f.interrupt("i1", "a1"),
          f.prompt("p2", "i1", "Second"),
          f.toolUse("a2", "p2", "tool-2"),
        ]);
        const first = planOf(yield* contentOf("p1"));
        expect(first.events[0]?.type === "run.created" && first.events[0].payload.status).toBe(
          "interrupted",
        );
        expect(itemsOf(first.events).find((item) => item.id === `x:${SESSION}:a1:0`)?.status).toBe(
          "interrupted",
        );
        const second = planOf(yield* contentOf("p2"), { ordinal: 2 });
        expect(itemsOf(second.events).find((item) => item.id === `x:${SESSION}:a2:0`)?.status).toBe(
          "running",
        );
      }),
    ),
  );

  it.effect("adds a prompt delivered into a running turn to that turn's run as a steer", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "First"),
          f.toolUse("a1", "p1", "t1", null),
          f.result("r1", "a1", "t1"),
          f.queued("q1", "r1", "Also"),
          f.text("a3", "q1", "Both done"),
        ]);
        const steer = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:q1`,
        );
        expect(steer).toMatchObject({ type: "user_message", inputIntent: "steer", text: "Also" });
      }),
    ),
  );

  it.effect("stands in the previous time for a line whose timestamp is not one", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.text("a1", "p1", "Hi", "end_turn", { timestamp: "not a time" }),
        ]);
        const plan = planOf(yield* contentOf("p1"));
        const reply = itemsOf(plan.events).find((item) => item.id === `x:${SESSION}:a1:0`);
        expect(reply === undefined ? undefined : DateTime.formatIso(reply.updatedAt)).toBe(
          f.iso(0),
        );
      }),
    ),
  );

  it.effect("caps tool output and says how much the transcript still holds", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const long = "o".repeat(NATIVE_TOOL_TEXT_MAX_CHARS + 10);
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.toolUse("a1", "p1", "tool-1"),
          f.user("r1", "a1", [{ type: "tool_result", tool_use_id: "tool-1", content: long }]),
          f.text("a2", "r1", "Done"),
        ]);
        const tool = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:a1:0`,
        );
        const output = tool?.type === "command_execution" ? tool.output : undefined;
        expect(
          typeof output === "string" &&
            output.endsWith("[10 more characters in the Claude transcript]"),
        ).toBe(true);
      }),
    ),
  );
});

describe("isClaudeOwnTurn and claimClaudeOwnTurnByText", () => {
  it.effect("finds T3 Code's turns by prompt uuid, prompt id, reply and copied line", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { index, tracker } = yield* transcript([
          f.prompt("p1", null, "One"),
          f.text("a1", "p1", "1"),
          f.prompt("p2", "a1", "Two", { promptId: "allocated" }),
          f.text("a2", "p2", "2"),
          f.prompt("p3", "a2", "Three"),
          f.text("a3", "p3", "3"),
          f.prompt("p4", "a3", "Four"),
          f.text("a4", "p4", "4"),
          f.prompt("p5", "a4", "Five", { forkedFrom: { sessionId: "parent", messageUuid: "m" } }),
          f.text("a5", "p5", "5"),
        ]);
        const own = {
          promptUuids: new Set(["p1", "allocated"]),
          assistantUuids: new Set(["a3"]),
          promptTexts: new Map(),
        };
        const ids = (skipCopied: boolean) =>
          tracker.turnIds().filter((turnId) => {
            const turn = tracker.turn(turnId);
            return turn !== undefined && isClaudeOwnTurn({ turn, index, own, skipCopied });
          });
        expect(ids(false)).toEqual(["p1", "p2", "p3"]);
        expect(ids(true)).toEqual(["p1", "p2", "p3", "p5"]);
      }),
    ),
  );

  it.effect("claims each older T3 Code turn by text once, never a turn already shown", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { index, tracker } = yield* transcript([
          f.prompt("p1", null, "continue"),
          f.text("a1", "p1", "1"),
          f.prompt("p2", "a1", "continue"),
          f.text("a2", "p2", "2"),
          f.prompt("p3", "a2", "continue"),
          f.text("a3", "p3", "3"),
        ]);
        const own = { ...noOwnTurns, promptTexts: new Map([[claudePromptTextKey("continue"), 1]]) };
        const claimed = (written: ReadonlyArray<string>) => {
          const unclaimed = new Map(own.promptTexts);
          return tracker.turnIds().filter((turnId) =>
            claimClaudeOwnTurnByText({
              turnId,
              index,
              unclaimed,
              written: written.includes(turnId),
            }),
          );
        };
        expect(claimed([])).toEqual(["p1"]);
        expect(claimed(["p1"])).toEqual(["p2"]);
      }),
    ),
  );
});

describe("planClaudeNativeTurn across reads", () => {
  it.effect(
    "writes only a later read's new lines, and finishes a tool when its result arrives",
    () =>
      run(
        Effect.gen(function* () {
          const f = claudeTranscriptFixture();
          const { contentOf, append } = yield* transcript([
            f.prompt("p1", null, "Go"),
            f.thinking("a0", "p1"),
            f.toolUse("a1", "a0", "tool-1", null),
          ]);
          const cache = newClaudeNativeTurnCache();
          const first = planOf(yield* contentOf("p1", cache), { cache });
          expect(
            itemsOf(first.events).find((item) => item.id === `x:${SESSION}:a1:0`)?.status,
          ).toBe("running");

          const update = yield* append([f.result("r1", "a1", "tool-1")]);
          expect(update.changedTurnIds).toEqual(["p1"]);
          const content = yield* contentOf("p1", cache);
          // The prompt, the thinking and the tool line are held, so only the result line is read.
          expect(content.lines.map((line) => line.lineUuid)).toEqual(["r1"]);
          expect(content.opener).toBeUndefined();
          const second = planOf(content, { cache, stored: true });
          expect(types(second.events)).toEqual([
            "run.updated",
            "run-attempt.updated",
            "node.updated",
            "provider-turn.updated",
            "turn-item.updated:command_execution",
          ]);
          expect(itemsOf(second.events)[0]).toMatchObject({ status: "completed", output: "done" });
        }),
      ),
  );

  it.effect("interrupts a tool still waiting when its turn ends", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf, append } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.toolUse("a1", "p1", "tool-1", null),
        ]);
        const cache = newClaudeNativeTurnCache();
        planOf(yield* contentOf("p1", cache), { cache });
        yield* append([f.interrupt("i1", "a1")]);
        const after = planOf(yield* contentOf("p1", cache), { cache, stored: true });
        expect(itemsOf(after.events).find((item) => item.id === `x:${SESSION}:a1:0`)?.status).toBe(
          "interrupted",
        );
      }),
    ),
  );

  it.effect("needs the whole turn for a result whose tool is held only as a hash", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf, append } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.toolUse("a1", "p1", "tool-1", null),
        ]);
        const whole = newClaudeNativeTurnCache();
        planOf(yield* contentOf("p1", whole), { cache: whole });
        yield* append([f.result("r1", "a1", "tool-1")]);
        // A cache seeded from stored hashes holds no open tools.
        const seeded = newClaudeNativeTurnCache();
        for (const [lineUuid, hash] of whole.known) seeded.known.set(lineUuid, hash);
        const content = yield* contentOf("p1", seeded);
        expect(claudeNativeResultsNeedWholeTurn(content, seeded)).toBe(true);
        expect(claudeNativeResultsNeedWholeTurn(content, whole)).toBe(false);
      }),
    ),
  );
});

describe("claudeNativeOrdinals", () => {
  const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
  const s = Math.floor(at("2026-11-26T10:00:00.000Z") / 1000);

  it("keeps turns that start in the same second in turn order", () => {
    const ordinals = claudeNativeOrdinals(
      [
        { id: "a", startMs: at("2026-11-26T10:00:00.100Z") },
        { id: "b", startMs: at("2026-11-26T10:00:00.900Z") },
        { id: "c", startMs: at("2026-11-26T10:00:01.000Z") },
      ],
      new Set(),
    );
    expect([...ordinals]).toEqual([
      ["a", s],
      ["b", s + 1],
      ["c", s + 2],
    ]);
  });

  it("passes over ordinals T3 Code's runs hold, and follows an untimed turn after the one before it", () => {
    const ordinals = claudeNativeOrdinals(
      [
        { id: "a", startMs: at("2026-11-26T10:00:00.000Z") },
        { id: "b", startMs: Number.NaN },
        { id: "c", startMs: at("2026-11-26T10:00:00.000Z") },
      ],
      new Set([s + 1]),
    );
    expect([...ordinals]).toEqual([
      ["a", s],
      ["b", s + 2],
      ["c", s + 3],
    ]);
  });

  it("changes no earlier ordinal when a turn is appended, and only pushed ones when one is filed earlier", () => {
    const a = { id: "a", startMs: at("2026-11-26T10:00:00.000Z") };
    const base = [
      a,
      { id: "b", startMs: at("2026-11-26T10:00:00.500Z") },
      { id: "c", startMs: at("2026-11-26T10:05:00.000Z") },
    ];
    const before = claudeNativeOrdinals(base, new Set());
    const appended = claudeNativeOrdinals(
      [...base, { id: "d", startMs: at("2026-11-26T10:06:00.000Z") }],
      new Set(),
    );
    expect([...appended].slice(0, 3)).toEqual([...before]);
    // A late line files `x` between `a` and `b`: `b` is pushed one on, `c` stays.
    const filed = claudeNativeOrdinals(
      [a, { id: "x", startMs: at("2026-11-26T10:00:00.200Z") }, ...base.slice(1)],
      new Set(),
    );
    expect(filed.get("a")).toBe(before.get("a"));
    expect(filed.get("x")).toBe(s + 1);
    expect(filed.get("b")).toBe(s + 2);
    expect(filed.get("c")).toBe(before.get("c"));
  });
});

describe("claudeNativeOrdinals at the far end of time", () => {
  it("keeps every item position of a far-future turn a safe integer, and the order", () => {
    const year2300 = DateTime.toEpochMillis(DateTime.makeUnsafe("2300-01-01T00:00:00.000Z"));
    const ordinals = claudeNativeOrdinals(
      [
        { id: "a", startMs: year2300 },
        { id: "b", startMs: year2300 + 1000 },
        { id: "c", startMs: year2300 },
      ],
      new Set([MAX_RUN_ORDINAL]),
    );
    const values = [...ordinals.values()];
    expect(values).toEqual(values.toSorted((left, right) => left - right));
    for (const ordinal of values) {
      expect(ordinal).toBeLessThanOrEqual(MAX_RUN_ORDINAL);
      expect(
        Number.isSafeInteger(
          ordinal * TURN_ITEM_POSITIONS_PER_RUN + TURN_ITEM_POSITIONS_PER_RUN - 1,
        ),
      ).toBe(true);
    }
  });
});

describe("planClaudeRemovedItems", () => {
  it("moves items into one rolled-back run, writing that run only the first time", () => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`x:${SESSION}:gone:0`),
      threadId: target.threadId,
      runId: claudeNativeRunIds(SESSION, "p1").runId,
      nodeId: claudeNativeRunIds(SESSION, "p1").nodeId,
      providerThreadId: target.providerThreadId,
      providerTurnId: claudeNativeRunIds(SESSION, "p1").providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: null,
      startedAt: FALLBACK,
      completedAt: FALLBACK,
      updatedAt: FALLBACK,
      type: "reasoning",
      text: "Hmm",
      streaming: false,
    };
    const plan = (created: boolean) =>
      planClaudeRemovedItems({
        target,
        items: [item],
        created,
        ordinal: 9,
        providerTurnOrdinal: 9,
        at: FALLBACK,
        eventId: () => EventId.make(`event-${nextId++}`),
      });
    const first = plan(false);
    expect(types(first)).toEqual([
      "run.created",
      "run-attempt.created",
      "node.updated",
      "provider-turn.updated",
      "turn-item.updated:reasoning",
    ]);
    expect(first[0]?.type === "run.created" && first[0].payload.status).toBe("rolled_back");
    expect(itemsOf(plan(true)).map((moved) => moved.runId)).toEqual([
      claudeNativeRunIds(SESSION, REMOVED_TURN_ID).runId,
    ]);
  });
});

describe("claudeNativeItemLineUuid", () => {
  it("reads the line uuid of a block's or a line's item id, and nothing of another scope", () => {
    expect(claudeNativeItemLineUuid(SESSION, `x:${SESSION}:a1:2`)).toBe("a1");
    expect(claudeNativeItemLineUuid(SESSION, `x:${SESSION}:p1`)).toBe("p1");
    expect(claudeNativeItemLineUuid(SESSION, "x:other:p1")).toBeUndefined();
  });
});
