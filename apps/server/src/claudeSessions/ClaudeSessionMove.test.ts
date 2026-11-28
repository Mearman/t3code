import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClaudeSessionCodePackage,
  ClaudeSessionReplicationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerClaudeSessions from "../peer/PeerClaudeSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeLiveSessions } from "./ClaudeLiveSessions.ts";
import * as ClaudeSessionMove from "./ClaudeSessionMove.ts";
import type { ClaudeSessionHolder } from "./ClaudeSessionRegistry.ts";
import { ClaudeSessionReplication } from "./ClaudeSessionReplication.ts";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const { claudeResumeCommand, releaseClaudeSession } = ClaudeSessionMove;

const holder = (status: string, confirmed: boolean): ClaudeSessionHolder => ({
  entry: { pid: 4242, sessionId: SESSION, cwd: "/work", status },
  confirmed,
});
const holding = (found: ClaudeSessionHolder | undefined) => () =>
  Effect.succeed(new Map(found === undefined ? [] : [[SESSION, found]]));

describe("claudeResumeCommand", () => {
  it("resumes from the session's directory with the default home", () => {
    expect(
      claudeResumeCommand({
        sessionId: SESSION,
        cwd: "/work/it's here",
        home: "/home/me/.claude",
        defaultHome: "/home/me/.claude",
      }),
    ).toBe(`cd '/work/it'\\''s here' && claude --resume ${SESSION}`);
  });

  it("names a home other than the default", () => {
    expect(
      claudeResumeCommand({
        sessionId: SESSION,
        cwd: null,
        home: "/home/me/.claude-work",
        defaultHome: "/home/me/.claude",
      }),
    ).toBe(`CLAUDE_CONFIG_DIR='/home/me/.claude-work' claude --resume ${SESSION}`);
  });
});

describe("releaseClaudeSession", () => {
  const release = (input: {
    readonly takeOver: boolean;
    readonly holders: (
      sessionsDir: string,
    ) => Effect.Effect<ReadonlyMap<string, ClaudeSessionHolder>>;
    readonly signalled: Array<number>;
    readonly onSignal?: () => void;
  }) =>
    releaseClaudeSession({
      sessionsDir: "/sessions",
      sessionId: SESSION,
      takeOver: input.takeOver,
      holders: input.holders,
      pause: Effect.void,
      signal: (pid) =>
        Effect.sync(() => {
          input.signalled.push(pid);
          input.onSignal?.();
        }),
    });

  it.effect("refuses a held session without take over, and signals nothing", () =>
    Effect.gen(function* () {
      const signalled: Array<number> = [];
      const refused = yield* Effect.flip(
        release({ takeOver: false, holders: holding(holder("idle", true)), signalled }),
      );
      expect(refused.reason).toBe("held");
      expect(signalled).toEqual([]);
    }),
  );

  it.effect("never ends a holder that is working, even with take over", () =>
    Effect.gen(function* () {
      const signalled: Array<number> = [];
      const refused = yield* Effect.flip(
        release({ takeOver: true, holders: holding(holder("busy", true)), signalled }),
      );
      expect(refused.reason).toBe("busy");
      expect(signalled).toEqual([]);
    }),
  );

  it.effect("never signals a pid it cannot confirm is still that claude", () =>
    Effect.gen(function* () {
      const signalled: Array<number> = [];
      const refused = yield* Effect.flip(
        release({ takeOver: true, holders: holding(holder("idle", false)), signalled }),
      );
      expect(refused.reason).toBe("held");
      expect(signalled).toEqual([]);
    }),
  );

  it.effect("ends the confirmed idle holder once and returns when it has gone", () =>
    Effect.gen(function* () {
      const signalled: Array<number> = [];
      let checks = 0;
      // It takes a check after the signal to go, so a second signal would show here.
      yield* release({
        takeOver: true,
        holders: () =>
          Effect.sync(() => new Map(checks++ < 2 ? [[SESSION, holder("idle", true)]] : [])),
        signalled,
      });
      expect(signalled).toEqual([4242]);
    }),
  );

  it.effect("lets a session nobody holds go", () =>
    release({ takeOver: false, holders: holding(undefined), signalled: [] }),
  );
});

const summary = (environmentId: EnvironmentId, access: "full-access" | "read-only") => ({
  environmentId,
  label: environmentId,
  urls: [`http://127.0.0.1/${environmentId}`],
  access,
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0, 1)),
  lastReachedAt: null,
  lastError: null,
  status: "reachable" as const,
});

/** The move service over fakes that count what it asks of the live sessions and the peers. */
const movesWith = (options: {
  readonly reserveGiB?: number;
  readonly linked?: ReadonlyArray<ReturnType<typeof summary>>;
  readonly takesMoves?: (environmentId: EnvironmentId) => boolean;
  readonly code?: ClaudeSessionCodePackage;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const calls = { holders: 0, manifests: 0, chunks: 0 };
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(root, { prefix: "move" }),
      ServerSettings.layerTest({
        linkedEnvironmentsEnabled: true,
        worktreesDirectory: `${root}/worktrees`,
        claudeSessionSync: { replication: { reserveGiB: options.reserveGiB ?? 0 } },
      }),
      Layer.mock(ClaudeSessionReplication)({
        ownedSession: () =>
          Effect.succeed({
            layout: { projectsDir: `${root}/projects`, home: root },
            transcriptPath: `${root}/projects/-work/${SESSION}.jsonl`,
            cwd: null,
          }),
      }),
      Layer.mock(PeerClaudeSessions.PeerClaudeSessions)({
        checkMoveTarget: (environmentId) =>
          options.takesMoves?.(environmentId) === true
            ? Effect.void
            : Effect.fail(
                new ClaudeSessionReplicationError({
                  reason: "unsupported",
                  message: "The target does not take moves.",
                }),
              ),
        moveManifest: () =>
          Effect.sync(() => {
            calls.manifests++;
            return options.code ?? { kind: "none" as const, cwd: null };
          }),
        readMoveChunk: () =>
          Effect.sync(() => void calls.chunks++).pipe(Effect.andThen(Effect.die("read"))),
      }),
      Layer.mock(PeerLinks.PeerLinks)({
        get: (environmentId) => Effect.succeedSome(summary(environmentId, "full-access")),
        list: Effect.succeed(options.linked ?? []),
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
      Layer.mock(ClaudeLiveSessions)({
        holders: () =>
          Effect.sync(() => {
            calls.holders++;
            return new Map([[SESSION, holder("idle", true)]]);
          }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-here")),
      }),
      SecureRandom.layerWebCrypto,
    );
    const moves = yield* ClaudeSessionMove.ClaudeSessionMove.pipe(
      Effect.provide(ClaudeSessionMove.layer.pipe(Layer.provide(dependencies))),
    );
    return { moves, calls };
  });

const MOVE = "0123456789abcdef0123456789abcdef";
const source = EnvironmentId.make("environment-source");

it.layer(NodeServices.layer)("ClaudeSessionMove", (it) => {
  it.effect("asks the target before take over ends anyone's claude", () =>
    Effect.gen(function* () {
      const { moves, calls } = yield* movesWith({});

      const refused = yield* Effect.flip(
        moves.move({
          sessionId: SESSION,
          targetEnvironmentId: EnvironmentId.make("environment-target"),
          takeOver: true,
        }),
      );

      expect(refused.reason).toBe("unsupported");
      expect(calls.holders).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a move id that climbs out", moveId: "../..", sessionId: SESSION },
    { name: "a session id that climbs out", moveId: MOVE, sessionId: "../.." },
  ])("refuses an offer naming $name before asking the source for anything", (offer) =>
    Effect.gen(function* () {
      const { moves, calls } = yield* movesWith({});

      const refused = yield* Effect.flip(moves.accept({ ...offer, sourceEnvironmentId: source }));

      expect(refused.reason).toBe("refused");
      expect(calls.manifests).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the reserve before fetching any of a move's code", () =>
    Effect.gen(function* () {
      const bytes = 1024;
      const { moves, calls } = yield* movesWith({
        reserveGiB: 1_000_000,
        code: {
          kind: "git",
          canonicalKey: "example/repo",
          remoteUrl: "https://example.com/repo.git",
          relativeCwd: "",
          head: "a".repeat(40),
          branch: "main",
          bundle: { path: "bundle", size: bytes, sha256: "0".repeat(64) },
          staged: null,
          unstaged: null,
          untracked: [],
        },
      });

      const refused = yield* Effect.flip(
        moves.accept({ moveId: MOVE, sessionId: SESSION, sourceEnvironmentId: source }),
      );

      expect(refused.reason).toBe("storage");
      expect(refused.message).toContain("1000000 GB free");
      expect(calls.chunks).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("offers only full-access links whose peer takes moves", () =>
    Effect.gen(function* () {
      const reader = EnvironmentId.make("environment-reader");
      const older = EnvironmentId.make("environment-older");
      const taker = EnvironmentId.make("environment-taker");
      const { moves } = yield* movesWith({
        linked: [
          summary(reader, "read-only"),
          summary(older, "full-access"),
          summary(taker, "full-access"),
        ],
        takesMoves: (environmentId) => environmentId !== older,
      });

      expect(yield* moves.targets).toEqual([{ environmentId: taker, label: taker }]);
    }).pipe(Effect.scoped),
  );
});
