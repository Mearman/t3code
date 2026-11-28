// @effect-diagnostics nodeBuiltinImport:off - node:crypto mints session ids for the fixtures.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ClaudeSessionReplicationError,
  EnvironmentId,
  type ClaudeRemoteSessionList,
  type ClaudeSessionManifest,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PeerClaudeSessions from "../peer/PeerClaudeSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ClaudeSessionReplicas from "../persistence/ClaudeSessionReplicas.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeLiveSessions } from "./ClaudeLiveSessions.ts";
import { ClaudeProcessTableError } from "./ClaudeProcessTable.ts";
import { sha256OfBytes } from "./ClaudeSessionFiles.ts";
import * as ClaudeSessionOwnershipGate from "./ClaudeSessionOwnershipGate.ts";
import {
  ClaudeSessionReplication,
  decodeListCursor,
  layer as replicationLayer,
} from "./ClaudeSessionReplication.ts";

const A = EnvironmentId.make("environment-a");
const B = EnvironmentId.make("environment-b");
const C = EnvironmentId.make("environment-c");

type Replication = ClaudeSessionReplication["Service"];

/** Two environments, each with its own database, Claude home and replication service. */
const environments = (options?: {
  readonly reserveGiB?: number;
  /** Rewrites what B hears from A's manifest, as a buggy or hostile owner would send. */
  readonly tamperList?: (list: ClaudeRemoteSessionList) => ClaudeRemoteSessionList;
  readonly tamper?: (manifest: ClaudeSessionManifest) => ClaudeSessionManifest;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const services = new Map<string, Replication>();
    const live = new Map<string, Set<string>>();
    /** Environments whose process table cannot be read. */
    const unreadable = new Set<string>();
    /** Manifests B asked its owners for. */
    const manifests: Array<string> = [];
    const down = new Set<string>();
    /** Runs before each chunk B reads from A, to act in the middle of a copy. */
    const onChunk = { run: (): Effect.Effect<void> => Effect.void };
    /** Runs before each claim B sends to A. */
    const onClaim = { run: (): Effect.Effect<void> => Effect.void };
    const service = (environmentId: EnvironmentId) =>
      Effect.suspend(() => {
        const found = services.get(environmentId);
        if (found === undefined || down.has(environmentId)) {
          return Effect.fail(
            new ClaudeSessionReplicationError({
              reason: "unreachable",
              message: `${environmentId} did not answer.`,
            }),
          );
        }
        return Effect.succeed(found);
      });

    const build = (self: EnvironmentId, others: ReadonlyArray<EnvironmentId>) =>
      Effect.gen(function* () {
        const home = path.join(root, self, "claude");
        yield* fileSystem.makeDirectory(path.join(home, "projects"), { recursive: true });
        live.set(self, new Set());
        const summary = (environmentId: EnvironmentId): PeerLinkSummary => ({
          environmentId,
          label: environmentId,
          urls: [`http://127.0.0.1/${environmentId}`],
          access: "full-access",
          linkedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0, 1)),
          lastReachedAt: null,
          lastError: null,
          status: "reachable",
        });
        const peers = Layer.mock(PeerClaudeSessions.PeerClaudeSessions)({
          list: (environmentId, listOptions) =>
            Effect.flatMap(service(environmentId), (owner) =>
              owner.listOwned(listOptions ?? {}),
            ).pipe(Effect.map((list) => options?.tamperList?.(list) ?? list)),
          confirmClaim: ({ environmentId, sessionId, nonce }) =>
            Effect.flatMap(service(environmentId), (peer) =>
              peer.confirmClaim({ sessionId, nonce }),
            ),
          manifest: ({ environmentId, sessionId, prefixBytes }) =>
            Effect.sync(() => void manifests.push(sessionId)).pipe(
              Effect.andThen(service(environmentId)),
              Effect.flatMap((owner) =>
                owner.manifest({
                  sessionId,
                  ...(prefixBytes === undefined ? {} : { prefixBytes }),
                }),
              ),
              Effect.map((manifest) => options?.tamper?.(manifest) ?? manifest),
            ),
          readChunk: ({ environmentId, ...chunk }) =>
            Effect.flatMap(onChunk.run(), () =>
              Effect.flatMap(service(environmentId), (owner) => owner.readFile(chunk)),
            ).pipe(Effect.map(({ bytes }) => bytes)),
          claim: ({ environmentId, claim }) =>
            Effect.flatMap(onClaim.run(), () => service(environmentId)).pipe(
              Effect.flatMap((owner) => owner.claim(claim)),
              Effect.as({ accepted: true as const }),
            ),
        });
        const links = Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          list: Effect.succeed(others.map(summary)),
          get: (environmentId) =>
            Effect.succeed(
              others.includes(environmentId) ? Option.some(summary(environmentId)) : Option.none(),
            ),
        });
        // The fork the SDK makes: the same lines under a new id beside the original.
        const runner = Layer.mock(ClaudeAgentSdkQueryRunner)({
          forkSession: ({ sessionId }) =>
            Effect.gen(function* () {
              const projects = path.join(home, "projects");
              for (const slug of yield* fileSystem.readDirectory(projects)) {
                const source = path.join(projects, slug, `${sessionId}.jsonl`);
                if (!(yield* fileSystem.exists(source))) continue;
                const forked = NodeCrypto.randomUUID();
                yield* fileSystem.copyFile(source, path.join(projects, slug, `${forked}.jsonl`));
                return { sessionId: forked };
              }
              return yield* Effect.die(`No transcript for ${sessionId}.`);
            }).pipe(Effect.orDie),
        });
        const dependencies = Layer.mergeAll(
          peers,
          links,
          runner,
          ClaudeSessionReplicas.layer,
          ClaudeSessionOwnershipGate.layer,
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(null),
          }),
          Layer.mock(ClaudeLiveSessions)({
            readOrFail: () =>
              unreadable.has(self)
                ? Effect.fail(new ClaudeProcessTableError({ reason: "ps did not run" }))
                : Effect.sync(() => new Set(live.get(self))),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(self),
          }),
          ServerSettings.layerTest({
            linkedEnvironmentsEnabled: true,
            claudeSessionSync: {
              replication: { everything: true, reserveGiB: options?.reserveGiB ?? 0 },
            },
          }),
          Layer.succeed(HostProcess.Environment, { CLAUDE_CONFIG_DIR: home }),
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
        const context = yield* Layer.build(replicationLayer.pipe(Layer.provideMerge(dependencies)));
        services.set(self, Context.get(context, ClaudeSessionReplication));
        return {
          home,
          replication: Context.get(context, ClaudeSessionReplication),
          replicas: Context.get(context, ClaudeSessionReplicas.ClaudeSessionReplicaRepository),
          gate: Context.get(context, ClaudeSessionOwnershipGate.ClaudeSessionOwnershipGate),
          sql: Context.get(context, SqlClient.SqlClient),
        };
      });

    const a = yield* build(A, [B]);
    const b = yield* build(B, [A]);

    /** A session `a` owns, as its sync records it: a transcript and one sidecar. */
    const ownSession = (input: {
      readonly cwd?: string;
      readonly lines?: ReadonlyArray<string>;
      /** The transcript's mtime as the owner's sync records it. */
      readonly mtimeMs?: number;
    }) =>
      Effect.gen(function* () {
        const sessionId = NodeCrypto.randomUUID();
        const transcript = path.join(a.home, "projects", "-work", `${sessionId}.jsonl`);
        yield* fileSystem.makeDirectory(
          path.join(path.dirname(transcript), sessionId, "tool-results"),
          {
            recursive: true,
          },
        );
        yield* fileSystem.writeFileString(
          transcript,
          (input.lines ?? ["one"]).map((l) => `${l}\n`).join(""),
        );
        yield* fileSystem.writeFileString(
          path.join(path.dirname(transcript), sessionId, "tool-results", "r.txt"),
          "result",
        );
        const size = Number((yield* fileSystem.stat(transcript)).size);
        yield* a.sql`
          INSERT INTO fork_claude_session_sync_state (
            store_key, session_id, file_identity, thread_id, provider_thread_id,
            account_uuids_json, hydration_state, updated_at, file_path, file_size, file_mtime_ms, cwd
          ) VALUES (
            'store', ${sessionId}, 'id', NULL, NULL, '[]', 'entry', '2026-11-27T00:00:00.000Z',
            ${transcript}, ${size}, ${input.mtimeMs ?? 1700000000000}, ${input.cwd ?? "/work"}
          )
        `;
        return { sessionId, transcript };
      });

    const copyOn = (environment: { readonly home: string }, sessionId: string) =>
      path.join(environment.home, "projects", "-work", `${sessionId}.jsonl`);

    return {
      a,
      b,
      root,
      ownSession,
      copyOn,
      live,
      unreadable,
      manifests,
      down,
      onChunk,
      onClaim,
      append: (file: string, line: string) =>
        fileSystem.writeFileString(file, `${line}\n`, { flag: "a" }),
      bytes: (file: string) => fileSystem.readFile(file).pipe(Effect.map(sha256OfBytes)),
    };
  });

const testLayer = Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer);

it.layer(testLayer)("ClaudeSessionReplication between two environments", (it) => {
  it.effect("copies an owned session byte for byte and records the instance holding it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});

      const report = yield* env.b.replication.replicateNow;

      expect(yield* env.bytes(env.copyOn(env.b, sessionId))).toBe(yield* env.bytes(transcript));
      expect(report.replicas.map((r) => [r.sessionId, r.providerInstanceId, r.status])).toEqual([
        [sessionId, "claudeAgent", "current"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("names a copy by its thread's title once the sync shows it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      const untitled = yield* env.b.replication.replicateNow;
      yield* env.b.sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`claude:${sessionId}`}, 'project', 'Fix the login flow', 'claudeAgent', 'full-access',
          'default', '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z', '{}'
        )
      `;

      const titled = yield* env.b.replication.report;

      expect(untitled.replicas.map((r) => r.title)).toEqual([null]);
      expect(titled.replicas.map((r) => r.title)).toEqual(["Fix the login flow"]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a copy the reserve does not leave room for, and reports it", () =>
    Effect.gen(function* () {
      const env = yield* environments({ reserveGiB: 1024 ** 3 });
      const { sessionId } = yield* env.ownSession({});
      const fileSystem = yield* FileSystem.FileSystem;

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped.map((s) => [s.sessionId, s.reason])).toEqual([
        [sessionId, "disk_reserve"],
      ]);
      expect(yield* fileSystem.exists(env.copyOn(env.b, sessionId))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a copy alone while a claude here holds it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(transcript, "owner moved on");
      env.live.get(B)?.add(sessionId);

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped.map((s) => s.reason)).toEqual(["held"]);
    }).pipe(Effect.scoped),
  );

  it.effect("copies nothing for a listed id that is not a session's", () =>
    Effect.gen(function* () {
      const env = yield* environments({
        tamperList: (list) => ({
          ...list,
          sessions: list.sessions.map((session) => ({ ...session, sessionId: "../../outside" })),
        }),
      });
      yield* env.ownSession({});

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped.map((s) => [s.sessionId, s.reason])).toEqual([
        ["../../outside", "failed"],
      ]);
      expect(report.replicas).toEqual([]);
      expect(env.manifests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a copy alone when it cannot tell whether a claude here holds it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      const before = yield* env.bytes(env.copyOn(env.b, sessionId));
      yield* env.append(transcript, "owner moved on");
      env.unreadable.add(B);

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped[0]?.message).toContain("could not read which claude processes");
      expect(yield* env.bytes(env.copyOn(env.b, sessionId))).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a session the owner cannot tell is free when a copy claims it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(env.copyOn(env.b, sessionId), "asked on the copy");
      env.unreadable.add(A);

      yield* env.b.replication.replicateNow;

      expect((yield* env.b.replicas.get(sessionId))?.ownerEnvironmentId).toBe(A);
      expect(yield* env.a.replicas.get(sessionId)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a copy a claude opens while it is being updated", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      const before = yield* env.bytes(env.copyOn(env.b, sessionId));
      yield* env.append(transcript, "owner moved on");
      env.onChunk.run = () => Effect.sync(() => void env.live.get(B)?.add(sessionId));

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped.map((s) => s.reason)).toEqual(["failed"]);
      expect(report.skipped[0]?.message).toContain("opened this copy");
      expect(yield* env.bytes(env.copyOn(env.b, sessionId))).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an owner whose manifest names a path outside the session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = yield* environments({
        tamper: (manifest) => ({
          ...manifest,
          sidecars: [
            ...manifest.sidecars,
            {
              path: `file-history/${manifest.sessionId}/../../../../escape`,
              size: 1,
              sha256: "0".repeat(64),
            },
          ],
        }),
      });
      const { sessionId } = yield* env.ownSession({});

      const report = yield* env.b.replication.replicateNow;

      expect(report.skipped.map((s) => s.reason)).toEqual(["failed"]);
      expect(yield* fileSystem.exists(env.copyOn(env.b, sessionId))).toBe(false);
      expect(yield* fileSystem.exists(path.join(env.root, "escape"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("moves ownership to a copy Claude appended to while the owner stood still", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(env.copyOn(env.b, sessionId), "asked on the copy");

      yield* env.b.replication.replicateNow;

      expect(yield* env.b.replicas.get(sessionId)).toBeUndefined();
      expect((yield* env.a.replicas.get(sessionId))?.ownerEnvironmentId).toBe(B);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a claim the environment it names did not send", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});
      const bytes = yield* (yield* FileSystem.FileSystem).readFile(transcript);

      const refused = yield* Effect.flip(
        env.a.replication.claim({
          sessionId,
          claimantEnvironmentId: B,
          size: bytes.byteLength,
          sha256: sha256OfBytes(bytes),
          nonce: "0".repeat(32),
        }),
      );

      expect(refused.message).toContain("did not confirm");
      expect(yield* env.a.replicas.get(sessionId)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a claim naming an environment the owner has no link back to", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      const refused = yield* Effect.flip(
        env.a.replication.claim({
          sessionId,
          claimantEnvironmentId: C,
          size: 0,
          sha256: "0".repeat(64),
          nonce: "0".repeat(32),
        }),
      );
      expect(refused.message).toContain("no link back");
    }).pipe(Effect.scoped),
  );

  it.effect("lets a send finish a claim the owner accepted but this copy did not record", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      const row = yield* env.b.replicas.get(sessionId);
      if (row === undefined) return expect.unreachable();
      // The owner already holds the claimant's copy as its replica; the claimant lost the answer.
      const ownerRow = { ...row, ownerEnvironmentId: B };
      yield* env.a.replicas.upsert({ ...ownerRow, transcriptPath: env.copyOn(env.a, sessionId) });
      yield* env.b.replication.start();

      // A send no longer meets a session nobody owns: claiming again finishes the move.
      const refusal = yield* env.b.gate.check(sessionId);

      expect(refusal?.message).toBeUndefined();
      expect(yield* env.b.replicas.get(sessionId)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("forks lines added on both sides once, even when the copy after it is cut short", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId, transcript } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(transcript, "owner moved on");
      yield* env.append(env.copyOn(env.b, sessionId), "copy moved on");
      env.onChunk.run = () => Effect.sync(() => void env.down.add(A));

      const cut = yield* env.b.replication.replicateNow;
      env.down.delete(A);
      env.onChunk.run = () => Effect.void;
      const again = yield* env.b.replication.replicateNow;

      expect(cut.skipped.map((s) => s.reason)).toEqual(["failed"]);
      expect(again.skipped).toEqual([]);
      expect((yield* env.b.replicas.get(sessionId))?.forkedSessionIds).toHaveLength(1);
      expect(yield* env.bytes(env.copyOn(env.b, sessionId))).toBe(yield* env.bytes(transcript));
    }).pipe(Effect.scoped),
  );

  it.effect("marks copies stale while their owner does not answer, and current again after", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      env.down.add(A);
      const stale = yield* env.b.replication.replicateNow;
      env.down.delete(A);
      const current = yield* env.b.replication.replicateNow;

      expect(stale.replicas.map((r) => r.status)).toEqual(["stale"]);
      expect(current.replicas.map((r) => r.status)).toEqual(["current"]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a send through a copy a pass claimed while the send waited for it", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const { sessionId } = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(env.copyOn(env.b, sessionId), "asked on the copy");
      const claiming = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The pass stops inside its claim, holding the session while the send waits for it.
      env.onClaim.run = () =>
        Deferred.succeed(claiming, undefined).pipe(Effect.andThen(Deferred.await(release)));
      const pass = yield* Effect.forkChild(env.b.replication.replicateNow);
      yield* Deferred.await(claiming);
      env.onClaim.run = () => Effect.void;
      yield* env.b.replication.start();
      const send = yield* Effect.forkChild(env.b.gate.check(sessionId));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pass);

      expect((yield* Fiber.join(send))?.message).toBeUndefined();
      expect((yield* env.a.replicas.get(sessionId))?.ownerEnvironmentId).toBe(B);
    }).pipe(Effect.scoped),
  );

  it.effect("claims a copy for a send while a pass waits on another session", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const first = yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      yield* env.append(env.copyOn(env.b, first.sessionId), "asked on the copy");
      const second = yield* env.ownSession({});
      const release = yield* Deferred.make<void>();
      // The pass copies the second session and stops in its first chunk read.
      env.onChunk.run = () => Deferred.await(release);
      const pass = yield* Effect.forkChild(env.b.replication.replicateNow);
      yield* Effect.yieldNow;
      yield* env.b.replication.start();

      const refusal = yield* env.b.gate.check(first.sessionId);

      expect(refusal?.message).toBeUndefined();
      expect(yield* env.b.replicas.get(first.sessionId)).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pass);
      expect(yield* env.bytes(env.copyOn(env.b, second.sessionId))).toBe(
        yield* env.bytes(second.transcript),
      );
    }).pipe(Effect.scoped),
  );
});

// Its own layer, since moving the test clock moves it for every test sharing one.
it.layer(testLayer)("change-only listings", (it) => {
  it.effect("copies a change the owner records only after its next full sweep", () =>
    Effect.gen(function* () {
      // Clocks well past the epoch, so a session with no thread or project sorts by its mtime.
      yield* TestClock.adjust("20000 days");
      const env = yield* environments();
      yield* env.ownSession({});
      yield* env.b.replication.replicateNow;
      // Changed twenty minutes ago, while nothing held it, and recorded only now.
      const late = yield* env.ownSession({
        mtimeMs: DateTime.toEpochMillis(yield* DateTime.now) - 20 * 60_000,
      });

      yield* env.b.replication.replicateNow;

      expect(yield* env.bytes(env.copyOn(env.b, late.sessionId))).toBe(
        yield* env.bytes(late.transcript),
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(testLayer)("listOwned", (it) => {
  it.effect("pages by change time, asks only for changes since, and matches text literally", () =>
    Effect.gen(function* () {
      const env = yield* environments();
      const made: Array<string> = [];
      for (let index = 0; index < 5; index++) {
        made.push(
          (yield* env.ownSession({ cwd: index === 2 ? "/work/100%" : "/work/100x" })).sessionId,
        );
      }
      yield* env.a.sql`
        UPDATE fork_claude_session_sync_state SET file_mtime_ms = CASE session_id
          ${env.a.sql.literal(made.map((id, index) => `WHEN '${id}' THEN ${1000 + index}`).join(" "))}
        END
      `;

      const first = yield* env.a.replication.listOwned({ limit: 2 });
      const second = yield* env.a.replication.listOwned({
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      });
      const changed = yield* env.a.replication.listOwned({ changedSinceMs: 1003 });
      const literal = yield* env.a.replication.listOwned({ query: "100%" });

      expect(first.sessions.map((s) => s.sessionId)).toEqual([made[4], made[3]]);
      expect(second.sessions.map((s) => s.sessionId)).toEqual([made[2], made[1]]);
      expect(changed.sessions.map((s) => s.sessionId)).toEqual([made[4], made[3]]);
      expect(changed.nextCursor).toBeNull();
      expect(literal.sessions.map((s) => s.sessionId)).toEqual([made[2]]);
    }).pipe(Effect.scoped),
  );
});

describe("decodeListCursor", () => {
  it("reads only cursors listOwned writes", () => {
    expect(decodeListCursor("12:0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b")).toEqual({
      changeMs: 12,
      sessionId: "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b",
    });
    expect(decodeListCursor("12:x' OR 1=1")).toBeUndefined();
  });
});

describe("PeerClaudeSessions.fromStatus", () => {
  it("says a peer has sessions turned off rather than that a session is gone", () => {
    const error = PeerClaudeSessions.fromStatus(403, "claude_sessions_off", "Box");
    expect(error.reason).toBe("refused");
    expect(error.message).toContain("turned off");
  });
});
