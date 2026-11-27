import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderMcpSignInError,
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
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  ClaudeProcessTableError,
  parseClaudeProcessTable,
  type ClaudeProcessRow,
} from "./ClaudeProcessTable.ts";
import { T3_CODE_ENTRYPOINT } from "../provider/Drivers/ClaudeHome.ts";
import { ClaudeSessionRegistryEntry } from "./ClaudeSessionRegistry.ts";
import {
  gateHeldClaudeSessionRuntime,
  probeClaudeSessionHold,
  type ClaudeSessionHold,
  claudeHolderSource,
} from "./ClaudeSessionSendGate.ts";

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ClaudeSessionRegistryEntry));

const START = "Thu Jan  1 00:00:00 2026";

const START_SECONDS = 1767225600;
const EARLIER = "Wed Dec 31 00:00:00 2025";

// 100 is the server, 101 a launcher its query runner spawned, 102 the claude that launcher runs,
// 103 a claude in the server's integrated terminal, 104 a claude 102's agent ran from its shell,
// 105 an older process left with 101's pid as parent, 200 a claude in another terminal.
const processes = parseClaudeProcessTable(
  [
    `  100     1   100 ${START}`,
    `  101   100   101 ${START}`,
    `  102   101   101 ${START}`,
    `  103   100   103 ${START}`,
    `  104   102   101 ${START}`,
    `  105   101   105 ${EARLIER}`,
    `  200     1   200 ${START}`,
  ].join("\n"),
);

it.layer(NodeServices.layer)("probeClaudeSessionHold", (it) => {
  const probeWith = (
    files: Record<string, string>,
    sessionId: string,
    // Runs between the probe's two registry reads, as Claude can write an entry during `ps`.
    readProcesses: (
      write: (written: Record<string, string>) => Effect.Effect<void>,
      // Dates a file as last written at `millis`.
      touch: (name: string, millis: number) => Effect.Effect<void>,
    ) => Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError> = () =>
      Effect.succeed(processes),
    matchStartTime = true,
    ownRootPids: Effect.Effect<ReadonlyArray<number>> = Effect.succeed([101]),
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionsDir = yield* fileSystem.makeTempDirectoryScoped();
      const write = (written: Record<string, string>) =>
        Effect.forEach(Object.entries(written), ([name, text]) =>
          fileSystem.writeFileString(path.join(sessionsDir, name), text),
        ).pipe(Effect.orDie);
      const touch = (name: string, millis: number) => {
        const at = DateTime.toDateUtc(DateTime.makeUnsafe(millis));
        return fileSystem.utimes(path.join(sessionsDir, name), at, at).pipe(Effect.orDie);
      };
      yield* write(files);
      return yield* probeClaudeSessionHold({
        sessionsDir,
        sessionId,
        ownRootPids,
        readProcesses: readProcesses(write, touch),
        matchStartTime,
      });
    });
  const writeDuringPs =
    (written: Record<string, string>) =>
    (write: (files: Record<string, string>) => Effect.Effect<void>) =>
      write(written).pipe(Effect.as(processes));
  const entry = (
    pid: number,
    sessionId: string,
    fields: Partial<ClaudeSessionRegistryEntry> = {},
  ) => encodeEntry({ pid, sessionId, cwd: "/work", procStart: START, ...fields });

  it.effect("leaves out only the CLI the server spawned, not a claude in its own terminal", () =>
    Effect.gen(function* () {
      const files = {
        "200.json": entry(200, "terminal"),
        "102.json": entry(102, "launched"),
        "103.json": entry(103, "integrated"),
      };
      expect(yield* probeWith(files, "terminal")).toEqual({
        _tag: "held",
        pid: 200,
        source: "unknown",
      });
      expect(yield* probeWith(files, "launched")).toBeUndefined();
      expect(yield* probeWith(files, "integrated")).toEqual({
        _tag: "held",
        pid: 103,
        source: "unknown",
      });
    }),
  );

  it.effect("checks startedAt where procStart cannot be matched, and else confirms nothing", () =>
    Effect.gen(function* () {
      const always = () => Effect.succeed(processes);
      const written = (startedAt: number) => ({
        "200.json": entry(200, "windows", { procStart: "not a time", startedAt }),
      });
      // The process started before it wrote the entry, so it is the one that wrote it.
      expect(
        yield* probeWith(written(START_SECONDS * 1000 + 500), "windows", always, false),
      ).toEqual({ _tag: "held", pid: 200, source: "unknown" });
      // It started after the entry was written, so it reused the pid.
      expect(
        yield* probeWith(written(START_SECONDS * 1000 - 60_000), "windows", always, false),
      ).toBeUndefined();
      // The same holds where procStart cannot be parsed.
      expect(yield* probeWith(written(START_SECONDS * 1000 + 500), "windows")).toEqual({
        _tag: "held",
        pid: 200,
        source: "unknown",
      });
      const pidOnly = { "200.json": entry(200, "windows", { procStart: "not a time" }) };
      expect(yield* probeWith(pidOnly, "windows", always, false)).toEqual({
        _tag: "unconfirmed",
        pid: 200,
      });
      expect(
        yield* probeWith({ "300.json": entry(300, "windows") }, "windows", always, false),
      ).toBeUndefined();
    }),
  );

  it.effect("counts a claude another Claude's agent ran as another writer", () =>
    Effect.gen(function* () {
      // Behind a launcher (101 runs 102), and with the spawned CLI itself writing the entry (101).
      const behindLauncher = {
        "102.json": entry(102, "launched"),
        "104.json": entry(104, "nested"),
      };
      expect(yield* probeWith(behindLauncher, "nested")).toEqual({
        _tag: "held",
        pid: 104,
        source: "unknown",
      });
      expect(yield* probeWith(behindLauncher, "launched")).toBeUndefined();
      const spawnedDirectly = {
        "101.json": entry(101, "spawned"),
        "102.json": entry(102, "nested"),
      };
      expect(yield* probeWith(spawnedDirectly, "nested")).toEqual({
        _tag: "held",
        pid: 102,
        source: "unknown",
      });
      expect(yield* probeWith(spawnedDirectly, "spawned")).toBeUndefined();
      // The same rule decides an unreadable entry below the spawned CLI's own.
      expect(
        yield* probeWith({ "101.json": entry(101, "spawned"), "102.json": '{"pid":102' }, "any"),
      ).toEqual({ _tag: "unreadable", pid: 102 });
    }),
  );

  it.effect("ignores a leftover file under a spawned launcher's reused pid", () =>
    Effect.gen(function* () {
      // 101 launches 102; a dead process that had pid 101 left a file behind.
      const withLeftover = (leftover: string) => ({
        "101.json": leftover,
        "102.json": entry(102, "launched"),
      });
      expect(
        yield* probeWith(withLeftover(entry(101, "gone", { procStart: EARLIER })), "launched"),
      ).toBeUndefined();
      const beforeStart = START_SECONDS * 1000 - 60_000;
      expect(
        yield* probeWith(
          withLeftover(entry(101, "gone", { startedAt: beforeStart })),
          "launched",
          () => Effect.succeed(processes),
          false,
        ),
      ).toBeUndefined();
      // An unreadable file is dated by when it was last written.
      const lastWritten = (written: number) =>
        probeWith(withLeftover('{"pid":101'), "launched", (_write, touch) =>
          touch("101.json", written).pipe(Effect.as(processes)),
        );
      expect(yield* lastWritten(beforeStart)).toBeUndefined();
      expect(yield* lastWritten(START_SECONDS * 1000 + 500)).toEqual({
        _tag: "held",
        pid: 102,
        source: "unknown",
      });
    }),
  );

  it.effect("counts an older process under a spawned CLI's pid as another writer", () =>
    Effect.gen(function* () {
      const files = { "105.json": entry(105, "orphaned", { procStart: EARLIER }) };
      expect(yield* probeWith(files, "orphaned")).toEqual({
        _tag: "held",
        pid: 105,
        source: "unknown",
      });
    }),
  );

  it.effect("needs no process table when only a spawned CLI's entry names the session", () =>
    Effect.gen(function* () {
      const unreadable = () =>
        Effect.fail(new ClaudeProcessTableError({ reason: "ps exited with 1" }));
      expect(
        yield* probeWith({ "101.json": entry(101, "own") }, "own", unreadable),
      ).toBeUndefined();
    }),
  );

  it.effect("keeps a spawned CLI that exits during the read as T3 Code's own", () =>
    Effect.gen(function* () {
      let reads = 0;
      // 101 launches 102, which wrote the entry; an unrelated entry forces the process read.
      const ownRootPids = Effect.sync(() => (reads++ === 0 ? [101] : []));
      const files = { "102.json": entry(102, "closing"), "300.json": entry(300, "closing") };
      expect(
        yield* probeWith(files, "closing", () => Effect.succeed(processes), true, ownRootPids),
      ).toBeUndefined();
    }),
  );

  it.effect(
    "reads T3 Code's own CLIs again after the registry, so one spawned meanwhile is own",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const ownRootPids = Effect.sync(() => (reads++ === 0 ? [] : [200]));
        const files = { "200.json": entry(200, "opening") };
        expect(
          yield* probeWith(files, "opening", () => Effect.succeed(processes), true, ownRootPids),
        ).toBeUndefined();
      }),
  );

  it.effect("tells how a holder was started from its registry entrypoint", () =>
    Effect.gen(function* () {
      const entrypoints = {
        terminal: "cli",
        print: "sdk-cli",
        sdkapp: "sdk-ts",
        t3: T3_CODE_ENTRYPOINT,
        desktop: "claude-desktop",
        bare: "sdk",
        glued: "sdkfoo",
        empty: "sdk-",
      } as const;
      // The live process is 200, so each holder gets its own registry and 200.json.
      const sourceOf = (sessionId: keyof typeof entrypoints) =>
        probeWith(
          { "200.json": entry(200, sessionId, { entrypoint: entrypoints[sessionId] }) },
          sessionId,
        ).pipe(Effect.map((hold) => (hold?._tag === "held" ? hold.source : undefined)));
      expect(yield* sourceOf("terminal")).toBe("terminal");
      expect(yield* sourceOf("print")).toBe("non-interactive");
      expect(yield* sourceOf("sdkapp")).toBe("agent-sdk");
      expect(yield* sourceOf("t3")).toBe("t3-code");
      for (const unrecognised of ["desktop", "bare", "glued", "empty"] as const) {
        expect(yield* sourceOf(unrecognised)).toBe("unknown");
      }
      expect(claudeHolderSource(undefined)).toBe("unknown");
    }),
  );

  it.effect("logs a holder whose entrypoint it does not recognise, and no other", () =>
    Effect.gen(function* () {
      const warnings: Array<Logger.Options<unknown>> = [];
      const probeLogged = (entrypoint: string | undefined) =>
        probeWith(
          { "200.json": entry(200, "logged", entrypoint === undefined ? {} : { entrypoint }) },
          "logged",
        ).pipe(
          Effect.provide(
            Logger.layer([Logger.make((logged) => warnings.push(logged))], {
              mergeWithExisting: false,
            }),
          ),
        );
      for (const recognised of ["cli", "sdk-cli", "sdk-ts", T3_CODE_ENTRYPOINT]) {
        yield* probeLogged(recognised);
      }
      expect(warnings).toEqual([]);
      yield* probeLogged("claude-desktop");
      yield* probeLogged(undefined);
      expect(warnings.map((logged) => logged.logLevel)).toEqual(["Warn", "Warn"]);
      const line = Logger.formatLogFmt.log(warnings[0]!);
      expect(line).toContain("unrecognised entrypoint");
      expect(line).toMatch(/pid\W+200/);
      expect(line).toContain("claude-desktop");
    }),
  );

  it.effect("calls a holder T3 Code's own by its entrypoint, whatever its parent", () =>
    Effect.gen(function* () {
      // 202 has init as its parent, as a CLI left running when T3 Code restarted has.
      const orphaned = { "202.json": entry(202, "left", { entrypoint: T3_CODE_ENTRYPOINT }) };
      const withOrphan = () =>
        Effect.succeed([...processes, ...parseClaudeProcessTable(`  202     1 202 ${START}`)]);
      expect(yield* probeWith(orphaned, "left", withOrphan)).toEqual({
        _tag: "held",
        pid: 202,
        source: "t3-code",
      });
      // A third-party Agent SDK app with the same parent is not blamed on T3 Code.
      const thirdParty = { "202.json": entry(202, "app", { entrypoint: "sdk-ts" }) };
      expect(yield* probeWith(thirdParty, "app", withOrphan)).toEqual({
        _tag: "held",
        pid: 202,
        source: "agent-sdk",
      });
    }),
  );

  it.effect("lets a session go once its holder has exited or its pid was reused", () =>
    Effect.gen(function* () {
      expect(yield* probeWith({ "300.json": entry(300, "exited") }, "exited")).toBeUndefined();
      const reused = {
        "200.json": entry(200, "reused", { procStart: "Fri Jan  2 00:00:00 2026" }),
      };
      expect(yield* probeWith(reused, "reused")).toBeUndefined();
    }),
  );

  it.effect(
    "blocks on an entry of a live process outside the server's tree that stays unreadable",
    () =>
      Effect.gen(function* () {
        expect(yield* probeWith({ "200.json": '{"pid":200' }, "any")).toEqual({
          _tag: "unreadable",
          pid: 200,
        });
        expect(yield* probeWith({ "102.json": '{"pid":102' }, "any")).toBeUndefined();
        expect(yield* probeWith({ "103.json": '{"pid":103' }, "any")).toEqual({
          _tag: "unreadable",
          pid: 103,
        });
        expect(yield* probeWith({ "300.json": '{"pid":300' }, "any")).toBeUndefined();
        // An entry that names its session despite an unknown shape blocks only that session.
        const named = { "200.json": '{"pid":200,"sessionId":"named"}' };
        expect(yield* probeWith(named, "other")).toBeUndefined();
        expect(yield* probeWith(named, "named")).toEqual({ _tag: "unreadable", pid: 200 });
      }),
  );

  it.effect("reads a half-written entry again before letting it block", () =>
    Effect.gen(function* () {
      const finished = { "200.json": entry(200, "elsewhere") };
      expect(
        yield* probeWith({ "200.json": '{"pid":20' }, "mine", writeDuringPs(finished)),
      ).toBeUndefined();
      const holding = { "200.json": entry(200, "mine") };
      expect(yield* probeWith({ "200.json": '{"pid":20' }, "mine", writeDuringPs(holding))).toEqual(
        {
          _tag: "held",
          pid: 200,
          source: "unknown",
        },
      );
    }),
  );

  it.effect("reads the process table only for an entry that may name the session", () =>
    Effect.gen(function* () {
      const unreadable = () =>
        Effect.fail(new ClaudeProcessTableError({ reason: "ps exited with 1" }));
      const files = { "200.json": entry(200, "terminal") };
      expect(yield* probeWith(files, "other", unreadable)).toBeUndefined();
      const failure = yield* Effect.flip(probeWith(files, "terminal", unreadable));
      expect(failure.message).toBe("Could not read the process table: ps exited with 1.");
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
    | "driver"
    | "resumeThread"
    | "startTurn"
    | "resumeTurn"
    | "compactThread"
    | "steerTurn"
    | "applyThreadTitle"
    | "stopTask"
    | "mcpApps"
    | "mcpSignIn"
    | "forkThread"
    | "liveNativeThreadId"
  >
>;

const REQUIREMENT = "Install ps.";

describe("gateHeldClaudeSessionRuntime", () => {
  // Every native operation records when it is called, so a gate that refuses late still fails.
  const makeGate = (input: {
    readonly hold?: ClaudeSessionHold;
    readonly probeFailure?: ClaudeProcessTableError;
    /** Fail this many probes with `probeFailure` before answering with `hold`. */
    readonly failingProbes?: number;
    readonly liveNativeThreadId?: string;
  }) => {
    const calls: Array<string> = [];
    const probes: Array<string> = [];
    const state = { hold: input.hold };
    const recorded = (name: string) => {
      calls.push(name);
      return Effect.void;
    };
    const fake: FakeRuntime = {
      driver,
      resumeThread: (resume) => {
        calls.push("resumeThread");
        return Effect.succeed(resume.providerThread);
      },
      startTurn: () => recorded("startTurn"),
      resumeTurn: () => recorded("resumeTurn"),
      compactThread: () => recorded("compactThread"),
      steerTurn: () => recorded("steerTurn"),
      applyThreadTitle: () => recorded("applyThreadTitle"),
      stopTask: () => recorded("stopTask"),
      mcpApps: {
        listTools: () => Effect.succeed([]),
        callTool: () => recorded("callTool").pipe(Effect.as({ content: [] })),
        readResource: () => Effect.succeed({ contents: [] }),
      },
      mcpSignIn: {
        start: () => recorded("mcpSignIn.start").pipe(Effect.as({ authorizationUrl: null })),
        complete: () => recorded("mcpSignIn.complete"),
      },
      forkThread: (fork) => {
        calls.push("forkThread");
        return Effect.succeed(fork.sourceProviderThread);
      },
      liveNativeThreadId: Effect.succeed(input.liveNativeThreadId),
    };
    const runtime = gateHeldClaudeSessionRuntime(
      fake,
      (sessionId) => {
        probes.push(sessionId);
        const failing = input.failingProbes ?? Number.POSITIVE_INFINITY;
        return input.probeFailure !== undefined && probes.length <= failing
          ? Effect.fail(input.probeFailure)
          : Effect.succeed(state.hold);
      },
      REQUIREMENT,
    );
    return { runtime, calls, probes, state };
  };
  // Each operation that would start, drive or write to the native session.
  const writes = (
    runtime: ReturnType<typeof makeGate>["runtime"],
    thread: OrchestrationV2ProviderThread,
    now: DateTime.Utc,
  ) => {
    const turn = turnInput(thread, now);
    const { message: _message, resume: _resume, ...resumeInput } = turn;
    const mcp = { providerThread: thread, server: "server" };
    return {
      resumeThread: runtime.resumeThread({ providerThread: thread }),
      startTurn: runtime.startTurn(turn),
      resumeTurn: runtime.resumeTurn({ ...resumeInput, messageId: turn.message.messageId }),
      compactThread: runtime.compactThread(turn),
      steerTurn: runtime.steerTurn({
        threadId,
        runId: turn.runId,
        providerThread: thread,
        providerTurnId: ProviderTurnId.make("provider-turn-held"),
        message: turn.message,
      }),
      callTool: runtime.mcpApps.callTool({ ...mcp, tool: "tool", arguments: {} }),
      mcpSignInStart: runtime.mcpSignIn.start(mcp),
      mcpSignInComplete: runtime.mcpSignIn.complete({ ...mcp, callbackUrl: "http://localhost/" }),
      checkNativeThreadFree: runtime.checkNativeThreadFree(thread),
    };
  };
  const TURN_STARTS = new Set(["startTurn", "resumeTurn", "compactThread"]);
  const refusals = (
    operations: Readonly<
      Record<
        string,
        Effect.Effect<unknown, ProviderAdapter.ProviderAdapterV2Error | ProviderMcpSignInError>
      >
    >,
  ) =>
    Effect.forEach(Object.entries(operations), ([name, operation]) =>
      Effect.flip(Effect.asVoid(operation)).pipe(Effect.map((refusal) => [name, refusal] as const)),
    );
  const expectInUse = (name: string, refusal: unknown, holderObserved: boolean) => {
    // The tag is what stops the turn start service from opening a fresh native session.
    if (TURN_STARTS.has(name)) {
      expect(refusal).toMatchObject({
        _tag: "ProviderAdapterTurnStartError",
        refusedBeforePrompt: true,
      });
    }
    const inUse =
      TURN_STARTS.has(name) && Predicate.hasProperty(refusal, "cause") ? refusal.cause : refusal;
    expect(Predicate.isTagged(inUse, "ProviderAdapterThreadInUseError")).toBe(true);
    expect(Predicate.hasProperty(inUse, "holderObserved") && inUse.holderObserved === true).toBe(
      holderObserved,
    );
  };

  it.effect("writes nothing to a held session and names the fork it offers", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls, probes } = makeGate({
        hold: { _tag: "held", pid: 200, source: "unknown" },
      });
      const operations = writes(runtime, providerThread(now), now);

      const refused = yield* refusals(operations);

      expect(calls).toEqual([]);
      expect(probes).toEqual(Object.keys(operations).map(() => "held-session"));
      for (const [name, refusal] of refused) expectInUse(name, refusal, true);
      const { message } = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );
      expect(message).toContain("pid 200");
      expect(message).toContain("Fork this conversation");
      expect(message).toContain("left out");
    }),
  );

  it.effect("marks a send that chose to fork, and nothing else, for the server to fork", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate({ hold: { _tag: "held", pid: 200, source: "terminal" } });
      const turn = turnInput(providerThread(now), now);
      const forked = { ...turn, message: { ...turn.message, heldSessionSend: "fork" as const } };
      const inUseOf = (refusal: unknown) =>
        Predicate.hasProperty(refusal, "cause") ? refusal.cause : refusal;
      const continued = (refusal: unknown) => {
        const inUse = inUseOf(refusal);
        return Predicate.hasProperty(inUse, "continueInFork") && inUse.continueInFork === true;
      };

      const fork = yield* Effect.flip(runtime.startTurn(forked));
      const asked = yield* Effect.flip(runtime.startTurn(turn));
      // A compaction would compact a copy, so it never forks whatever the send chose.
      const compacted = yield* Effect.flip(runtime.compactThread(forked));
      const steered = yield* Effect.flip(
        runtime.steerTurn({
          threadId,
          runId: forked.runId,
          providerThread: forked.providerThread,
          providerTurnId: ProviderTurnId.make("provider-turn-held"),
          message: forked.message,
        }),
      );

      expect(calls).toEqual([]);
      expect([fork, asked, compacted, steered].map(continued)).toEqual([true, false, false, false]);
      const forkError = inUseOf(fork);
      expect(Predicate.hasProperty(forkError, "message") ? String(forkError.message) : "").toContain(
        "continues this message in a fork",
      );
      expectInUse("startTurn", fork, true);
    }),
  );

  it.effect("never marks a fork where a holder was only possibly there", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime } = makeGate({ hold: { _tag: "unreadable", pid: 200 } });
      const turn = turnInput(providerThread(now), now);

      const refusal = yield* Effect.flip(
        runtime.startTurn({ ...turn, message: { ...turn.message, heldSessionSend: "fork" } }),
      );

      const inUse = Predicate.hasProperty(refusal, "cause") ? refusal.cause : refusal;
      expect(Predicate.hasProperty(inUse, "continueInFork")).toBe(false);
      expectInUse("startTurn", refusal, false);
    }),
  );

  it.effect("refuses for an unreadable entry without marking a holder as seen", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate({ hold: { _tag: "unreadable", pid: 200 } });

      const refused = yield* refusals(writes(runtime, providerThread(now), now));

      expect(calls).toEqual([]);
      for (const [name, refusal] of refused) expectInUse(name, refusal, false);
    }),
  );

  it.effect.each([
    { source: "terminal", text: "(pid 200, started from a terminal)", t3: false },
    { source: "non-interactive", text: "(pid 200, started non-interactively)", t3: false },
    { source: "agent-sdk", text: "(pid 200, started by an app using the Agent SDK)", t3: false },
    { source: "t3-code", text: "started by T3 Code outside this server", t3: true },
    { source: "unknown", text: "started in a way T3 Code does not recognise", t3: false },
  ] as const)(
    "words a $source holder, blaming T3 Code only for its own entrypoint",
    ({ source, text, t3 }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const { runtime } = makeGate({ hold: { _tag: "held", pid: 200, source } });

        const refusal = yield* Effect.flip(
          runtime.resumeThread({ providerThread: providerThread(now) }),
        );

        expect(refusal.message).toContain("Another Claude Code process (pid 200");
        expect(refusal.message).toContain(text);
        expect(refusal.message.includes("started by T3 Code")).toBe(t3);
      }),
  );

  it.effect("still forks a held session", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate({ hold: { _tag: "held", pid: 200, source: "unknown" } });

      yield* runtime.forkThread({
        sourceProviderThread: providerThread(now),
        targetThreadId: ThreadId.make("thread-fork"),
      });

      expect(calls).toEqual(["forkThread"]);
    }),
  );

  it.effect("still stops a task, which only makes T3 Code's own process write less", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls, probes } = makeGate({
        hold: { _tag: "held", pid: 200, source: "unknown" },
      });

      yield* runtime.stopTask({ providerThread: providerThread(now), taskId: "task" });

      expect(calls).toEqual(["stopTask"]);
      expect(probes).toEqual([]);
    }),
  );

  it.effect("leaves a held or unchecked title to the next turn without failing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const title = { providerThread: providerThread(now), title: "Renamed" };
      const held = makeGate({
        hold: { _tag: "held", pid: 200, source: "unknown" },
        liveNativeThreadId: "held-session",
      });
      yield* held.runtime.applyThreadTitle(title);
      const unchecked = makeGate({
        probeFailure: new ClaudeProcessTableError({ reason: "ps exited with 1" }),
        liveNativeThreadId: "held-session",
      });
      yield* unchecked.runtime.applyThreadTitle(title);
      // With nothing live the adapter itself waits for the next turn, so the gate does not probe.
      const idle = makeGate({ hold: { _tag: "held", pid: 200, source: "unknown" } });
      yield* idle.runtime.applyThreadTitle(title);
      const free = makeGate({ liveNativeThreadId: "held-session" });
      yield* free.runtime.applyThreadTitle(title);

      expect([held.calls, unchecked.calls, idle.calls, idle.probes, free.calls]).toEqual([
        [],
        [],
        ["applyThreadTitle"],
        [],
        ["applyThreadTitle"],
      ]);
    }),
  );

  it.effect("sends once the session is released, probing again on every send", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = providerThread(now);
      const { runtime, calls, probes, state } = makeGate({
        hold: { _tag: "held", pid: 200, source: "unknown" },
      });

      yield* Effect.flip(runtime.startTurn(turnInput(thread, now)));
      state.hold = undefined;
      yield* runtime.resumeThread({ providerThread: thread });
      yield* runtime.startTurn(turnInput(thread, now));

      expect(calls).toEqual(["resumeThread", "startTurn"]);
      expect(probes).toHaveLength(3);
    }),
  );

  it.effect("checks again before refusing, so a check that fails once still sends", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls, probes } = makeGate({
        probeFailure: new ClaudeProcessTableError({ reason: "ps timed out" }),
        failingProbes: 1,
      });

      yield* runtime.startTurn(turnInput(providerThread(now), now));

      expect(calls).toEqual(["startTurn"]);
      expect(probes).toHaveLength(2);
    }),
  );

  it.effect("checks an unconfirmed or unreadable holder again before refusing unmarked", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const hold of [
        { _tag: "unconfirmed", pid: 200 },
        { _tag: "unreadable", pid: 200 },
      ] as const) {
        const { runtime, probes } = makeGate({ hold });
        const refusal = yield* Effect.flip(
          runtime.resumeThread({ providerThread: providerThread(now) }),
        );
        expect(probes).toHaveLength(3);
        expectInUse("resumeThread", refusal, false);
        expect(refusal.message).not.toContain("Fork");
      }
    }),
  );

  it.effect("refuses every write unmarked, saying why, when the probe cannot read", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      // Even the session's own live process waits: another may have resumed it meanwhile.
      const { runtime, calls } = makeGate({
        probeFailure: new ClaudeProcessTableError({ reason: "ps exited with 1" }),
        liveNativeThreadId: "held-session",
      });

      const refused = yield* refusals(writes(runtime, providerThread(now), now));

      expect(calls).toEqual([]);
      for (const [name, refusal] of refused) expectInUse(name, refusal, false);
      const { message } = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );
      expect(message).toContain("Could not read the process table: ps exited with 1.");
      expect(message).toContain(REQUIREMENT);
    }),
  );
});
