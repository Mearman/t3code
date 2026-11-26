import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ClaudeProcessTableError,
  parseClaudeProcessTable,
  type ClaudeProcessRow,
} from "./ClaudeProcessTable.ts";
import { ClaudeSessionRegistryEntry } from "./ClaudeSessionRegistry.ts";
import {
  gateHeldClaudeSessionRuntime,
  probeClaudeSessionHold,
  type ClaudeSessionHold,
} from "./ClaudeSessionSendGate.ts";

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ClaudeSessionRegistryEntry));

const START = "Thu Jan  1 00:00:00 2026";

// 100 is the server, 101 a launcher it spawned, 102 the claude that launcher runs, 200 a terminal's.
const processes = parseClaudeProcessTable(
  [
    `  100     1   100 ${START}`,
    `  101   100   101 ${START}`,
    `  102   101   101 ${START}`,
    `  200     1   200 ${START}`,
  ].join("\n"),
);

it.layer(NodeServices.layer)("probeClaudeSessionHold", (it) => {
  const probeWith = (
    files: Record<string, string>,
    sessionId: string,
    readProcesses: Effect.Effect<
      ReadonlyArray<ClaudeProcessRow>,
      ClaudeProcessTableError
    > = Effect.succeed(processes),
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionsDir = yield* fileSystem.makeTempDirectoryScoped();
      for (const [name, text] of Object.entries(files)) {
        yield* fileSystem.writeFileString(path.join(sessionsDir, name), text);
      }
      return yield* probeClaudeSessionHold({
        sessionsDir,
        sessionId,
        ownRootPids: [100],
        readProcesses,
      });
    });
  const entry = (pid: number, sessionId: string, procStart = START) =>
    encodeEntry({ pid, sessionId, cwd: "/work", procStart });

  it.effect("finds a terminal's process and leaves out the server's own tree", () =>
    Effect.gen(function* () {
      const files = { "200.json": entry(200, "terminal"), "102.json": entry(102, "launched") };
      expect(yield* probeWith(files, "terminal")).toEqual({ _tag: "held", pid: 200 });
      expect(yield* probeWith(files, "launched")).toBeUndefined();
    }),
  );

  it.effect("lets a session go once its holder has exited or its pid was reused", () =>
    Effect.gen(function* () {
      expect(yield* probeWith({ "300.json": entry(300, "exited") }, "exited")).toBeUndefined();
      const reused = { "200.json": entry(200, "reused", "Fri Jan  2 00:00:00 2026") };
      expect(yield* probeWith(reused, "reused")).toBeUndefined();
    }),
  );

  it.effect("blocks on an unreadable entry of a live process outside the server's tree", () =>
    Effect.gen(function* () {
      expect(yield* probeWith({ "200.json": '{"pid":200' }, "any")).toEqual({
        _tag: "unreadable",
        pid: 200,
      });
      expect(yield* probeWith({ "102.json": '{"pid":102' }, "any")).toBeUndefined();
      expect(yield* probeWith({ "300.json": '{"pid":300' }, "any")).toBeUndefined();
      // An entry that names its session despite an unknown shape blocks only that session.
      const named = { "200.json": '{"pid":200,"sessionId":"named"}' };
      expect(yield* probeWith(named, "other")).toBeUndefined();
      expect(yield* probeWith(named, "named")).toEqual({ _tag: "unreadable", pid: 200 });
    }),
  );

  it.effect("reads the process table only for an entry that may name the session", () =>
    Effect.gen(function* () {
      const unreadable = Effect.fail(new ClaudeProcessTableError({ cause: "ps failed" }));
      const files = { "200.json": entry(200, "terminal") };
      expect(yield* probeWith(files, "other", unreadable)).toBeUndefined();
      const failure = yield* Effect.flip(probeWith(files, "terminal", unreadable));
      expect(failure._tag).toBe("ClaudeProcessTableError");
    }),
  );
});

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude");
const threadId = ThreadId.make("thread-held");
const modelSelection = { instanceId, model: "default" } as const;
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/work",
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread-held"),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "held-session", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-held"),
    title: "Held",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: thread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId,
  runId: RunId.make("run-held"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt-held"),
  rootNodeId: NodeId.make("node-held"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message-held"),
    text: "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  modelSelection,
  runtimePolicy,
});

type FakeRuntime = Required<
  Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    "resumeThread" | "startTurn" | "resumeTurn" | "compactThread" | "steerTurn" | "forkThread"
  >
>;

describe("gateHeldClaudeSessionRuntime", () => {
  // Every native operation records when it is called, so a gate that refuses late still fails.
  const makeGate = (
    initial: ClaudeSessionHold | undefined,
    probeFailure?: ClaudeProcessTableError,
  ) => {
    const calls: Array<string> = [];
    const probes: Array<string> = [];
    const state = { hold: initial };
    const recorded = (name: string) => {
      calls.push(name);
      return Effect.void;
    };
    const fake: FakeRuntime = {
      resumeThread: (input) => {
        calls.push("resumeThread");
        return Effect.succeed(input.providerThread);
      },
      startTurn: () => recorded("startTurn"),
      resumeTurn: () => recorded("resumeTurn"),
      compactThread: () => recorded("compactThread"),
      steerTurn: () => recorded("steerTurn"),
      forkThread: (input) => {
        calls.push("forkThread");
        return Effect.succeed(input.sourceProviderThread);
      },
    };
    const runtime = gateHeldClaudeSessionRuntime(fake, driver, (sessionId) => {
      probes.push(sessionId);
      return probeFailure === undefined ? Effect.succeed(state.hold) : Effect.fail(probeFailure);
    });
    return { runtime, calls, probes, state };
  };

  it.effect("sends nothing to a held session and names the fork option", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = providerThread(now);
      const turn = turnInput(thread, now);
      const { runtime, calls, probes } = makeGate({ _tag: "held", pid: 200 });

      const resumed = yield* Effect.flip(runtime.resumeThread({ providerThread: thread }));
      const started = yield* Effect.flip(runtime.startTurn(turn));
      const { message: _message, resume: _resume, ...resumeInput } = turn;
      const resumedTurn = yield* Effect.flip(
        runtime.resumeTurn({ ...resumeInput, messageId: turn.message.messageId }),
      );
      const compacted = yield* Effect.flip(runtime.compactThread(turn));
      const steered = yield* Effect.flip(
        runtime.steerTurn({
          threadId,
          runId: turn.runId,
          providerThread: thread,
          providerTurnId: ProviderTurnId.make("provider-turn-held"),
          message: turn.message,
        }),
      );

      expect(calls).toEqual([]);
      expect(probes).toEqual(Array.from({ length: 5 }, () => "held-session"));
      // The tag is what stops the turn start service from opening a fresh native session.
      for (const refusal of [resumed, steered]) {
        expect(refusal._tag).toBe("ProviderAdapterThreadInUseError");
      }
      for (const refusal of [started, resumedTurn, compacted]) {
        expect(refusal).toMatchObject({
          _tag: "ProviderAdapterTurnStartError",
          refusedBeforePrompt: true,
          cause: { _tag: "ProviderAdapterThreadInUseError" },
        });
      }
      expect(resumed.message).toContain("pid 200");
      expect(resumed.message).toContain('"Fork from this response"');
    }),
  );

  it.effect("still forks a held session", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate({ _tag: "held", pid: 200 });

      yield* runtime.forkThread({
        sourceProviderThread: providerThread(now),
        targetThreadId: ThreadId.make("thread-fork"),
      });

      expect(calls).toEqual(["forkThread"]);
    }),
  );

  it.effect("sends once the session is released, probing again on every send", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = providerThread(now);
      const { runtime, calls, probes, state } = makeGate({ _tag: "held", pid: 200 });

      yield* Effect.flip(runtime.startTurn(turnInput(thread, now)));
      state.hold = undefined;
      yield* runtime.resumeThread({ providerThread: thread });
      yield* runtime.startTurn(turnInput(thread, now));

      expect(calls).toEqual(["resumeThread", "startTurn"]);
      expect(probes).toHaveLength(3);
    }),
  );

  it.effect("refuses when the probe cannot read the registry or process table", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate(
        undefined,
        new ClaudeProcessTableError({ cause: "ps failed" }),
      );

      const refusal = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );

      expect(calls).toEqual([]);
      expect(refusal._tag).toBe("ProviderAdapterThreadInUseError");
      expect(refusal.message).toContain("could not check");
    }),
  );
});
