import {
  CLAUDE_BRIDGE_CONNECTION_DIRECTORY,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
  type ClaudeBridgeCommand,
  ClaudeBridgeConnection,
  type ClaudeBridgePoll,
  claudeBridgePromptText,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

// The mod polls about once a second; a session counts as attached while it polled this recently.
const ATTACHED_GRACE = Duration.seconds(10);
// A handed-out command the mod has not acknowledged is handed out again after this long.
const DELIVERY_LEASE = Duration.seconds(15);
// A command no mod has acknowledged within this long fails, and the person is told.
export const CLAUDE_BRIDGE_COMMAND_TTL = Duration.minutes(2);
// Bounds on what any holder of the token can make the server keep.
export const CLAUDE_BRIDGE_MAX_PENDING = 16;
export const CLAUDE_BRIDGE_MAX_SESSIONS = 64;

interface Pending {
  readonly command: ClaudeBridgeCommand;
  readonly threadId: string;
  readonly queuedAt: number;
  readonly handedOutAt: number | undefined;
  readonly firstHandedOutAt: number | undefined;
}

interface Session {
  readonly pollerKey: string;
  readonly lastPollAt: number;
  readonly pending: ReadonlyArray<Pending>;
}

/** A prompt the bridge took for a thread that never reached the terminal's `claude`. */
export interface ClaudeBridgeFailure {
  readonly threadId: string;
  readonly runId: string;
  readonly reason: string;
}

export class ClaudeBridgeSubmitError extends Schema.TaggedError<ClaudeBridgeSubmitError>()(
  "ClaudeBridgeSubmitError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Why a poll was turned away: another process polls that session, or too many sessions do. */
export type ClaudeBridgePollRefusal = "claimed" | "full";

/** A poll's answer: the commands to hand out, or why it was turned away. */
export type ClaudeBridgePollAnswer =
  | {
      readonly _tag: "accepted";
      readonly pollerKey: string;
      readonly commands: ReadonlyArray<ClaudeBridgeCommand>;
    }
  | { readonly _tag: "refused"; readonly reason: ClaudeBridgePollRefusal };

type PollOutcome =
  | (Extract<ClaudeBridgePollAnswer, { readonly _tag: "accepted" }> & {
      readonly refused: ReadonlyArray<{
        readonly item: Pending;
        readonly reason: string | undefined;
      }>;
      readonly expired: ReadonlyArray<Pending>;
    })
  | Extract<ClaudeBridgePollAnswer, { readonly _tag: "refused" }>;

/**
 * Sessions whose `claude` runs the T3 bridge mod and the prompts waiting for each. Only a mod
 * holding the token from this server's connection file reaches it; see `ClaudeBridgeHttp`.
 */
export class ClaudeBridge extends Context.Service<
  ClaudeBridge,
  {
    readonly token: string;
    /** Sent with every poll answer; the mod refuses an answer without it. */
    readonly proof: string;
    /** Whether a mod polled for `sessionId` within the grace, so a prompt for it can be queued. */
    readonly attached: (sessionId: string) => Effect.Effect<boolean>;
    /**
     * Queues a prompt for the mod, `asUser` only for a person's own words. Fails when no mod polls
     * the session or its queue is full. It stays queued until the mod acknowledges it, and expires
     * into `failures` after `CLAUDE_BRIDGE_COMMAND_TTL`.
     */
    readonly submit: (input: {
      readonly sessionId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly text: string;
      readonly asUser: boolean;
    }) => Effect.Effect<void, ClaudeBridgeSubmitError>;
    /** A mod's poll: records its acknowledgements and hands out what it has not yet taken. */
    readonly poll: (poll: ClaudeBridgePoll) => Effect.Effect<ClaudeBridgePollAnswer>;
    /** Prompts that did not reach the terminal: refused by the mod, or never taken. */
    readonly failures: Queue.Dequeue<ClaudeBridgeFailure>;
    /** A Claude home whose sessions may load the mod; it gets a connection file. */
    readonly registerHome: (home: string) => Effect.Effect<void>;
    /** The server's origin once it listens; every registered home gets the file. */
    readonly serveAt: (origin: string) => Effect.Effect<void>;
  }
>()("t3/claudeSessions/ClaudeBridge") {}

const encodeConnection = Schema.encodeSync(Schema.fromJsonString(ClaudeBridgeConnection));
const decodeConnection = Schema.decodeEffect(Schema.fromJsonString(ClaudeBridgeConnection));

// Signal 0 checks a process exists; only ESRCH says it does not.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(Predicate.hasProperty(cause, "code") && cause.code === "ESRCH");
  }
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hex = (bytes: number) =>
    Effect.map(random.randomBytes(bytes), (value) => Buffer.from(value).toString("hex"));
  const token = yield* hex(32);
  const proof = yield* hex(32);
  const serverId = yield* hex(8);
  const sessions = yield* Ref.make(new Map<string, Session>());
  const failures = yield* Queue.unbounded<ClaudeBridgeFailure>();
  const published = yield* Ref.make<{
    readonly origin: string | undefined;
    readonly homes: ReadonlySet<string>;
  }>({ origin: undefined, homes: new Set() });

  const isAttached = (session: Session | undefined, now: number) =>
    session !== undefined && now - session.lastPollAt <= Duration.toMillis(ATTACHED_GRACE);
  // A command the mod has taken is timed from then, so a slow submit is not reported lost.
  const isExpired = (item: Pending, now: number) =>
    now - (item.firstHandedOutAt ?? item.queuedAt) >= Duration.toMillis(CLAUDE_BRIDGE_COMMAND_TTL);
  const expiredFailure = (item: Pending): ClaudeBridgeFailure => ({
    threadId: item.threadId,
    runId: item.command.commandId,
    reason: "the terminal's claude did not take it in time",
  });

  // Drops expired prompts, and sessions no mod polls that hold nothing, reporting each prompt.
  const sweep = Effect.fn("ClaudeBridge.sweep")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const expired = yield* Ref.modify(sessions, (current) => {
      const gone: Array<Pending> = [];
      const next = new Map<string, Session>();
      for (const [sessionId, session] of current) {
        const live = session.pending.filter((item) => !isExpired(item, now));
        gone.push(...session.pending.filter((item) => !live.includes(item)));
        if (live.length > 0 || isAttached(session, now)) {
          next.set(sessionId, { ...session, pending: live });
        }
      }
      return [gone, next] as const;
    });
    yield* Queue.offerAll(failures, expired.map(expiredFailure));
  });

  const attached: ClaudeBridge["Service"]["attached"] = Effect.fn("ClaudeBridge.attached")(
    function* (sessionId) {
      const now = yield* Clock.currentTimeMillis;
      return isAttached((yield* Ref.get(sessions)).get(sessionId), now);
    },
  );

  const submit: ClaudeBridge["Service"]["submit"] = Effect.fn("ClaudeBridge.submit")(
    function* (input) {
      yield* sweep();
      const now = yield* Clock.currentTimeMillis;
      const command: ClaudeBridgeCommand = {
        type: "submit",
        commandId: input.runId,
        sessionId: input.sessionId,
        text: input.asUser ? input.text : claudeBridgePromptText(input.text),
        asUser: input.asUser,
      };
      const refusal = yield* Ref.modify(sessions, (current) => {
        const session = current.get(input.sessionId);
        if (session === undefined || !isAttached(session, now)) {
          return ["the T3 bridge mod is not polling for this session", current] as const;
        }
        if (session.pending.length >= CLAUDE_BRIDGE_MAX_PENDING) {
          return ["too many messages are already waiting for this terminal", current] as const;
        }
        if (session.pending.some((item) => item.command.commandId === input.runId)) {
          return [undefined, current] as const;
        }
        const pending: Pending = {
          command,
          threadId: input.threadId,
          queuedAt: now,
          handedOutAt: undefined,
          firstHandedOutAt: undefined,
        };
        return [
          undefined,
          new Map(current).set(input.sessionId, {
            ...session,
            pending: [...session.pending, pending],
          }),
        ] as const;
      });
      if (refusal !== undefined) return yield* new ClaudeBridgeSubmitError({ reason: refusal });
    },
  );

  const poll: ClaudeBridge["Service"]["poll"] = Effect.fn("ClaudeBridge.poll")(function* (request) {
    const now = yield* Clock.currentTimeMillis;
    const freshKey = yield* hex(16);
    const outcome = yield* Ref.modify(
      sessions,
      (current): readonly [PollOutcome, Map<string, Session>] => {
        const session = current.get(request.sessionId);
        const claimedElsewhere =
          session !== undefined &&
          isAttached(session, now) &&
          session.pollerKey !== request.pollerKey;
        if (claimedElsewhere) {
          return [{ _tag: "refused", reason: "claimed" }, current];
        }
        if (session === undefined && current.size >= CLAUDE_BRIDGE_MAX_SESSIONS) {
          return [{ _tag: "refused", reason: "full" }, current];
        }
        const acks = new Map(request.acks.map((ack) => [ack.commandId, ack]));
        // Acks first, so one in this poll never expires; then expiry, so nothing expired is handed out.
        const unacked = (session?.pending ?? []).filter(
          (item) => !acks.has(item.command.commandId),
        );
        const expired = unacked.filter((item) => isExpired(item, now));
        const kept = unacked.filter((item) => !isExpired(item, now));
        const refused = (session?.pending ?? []).flatMap((item) => {
          const ack = acks.get(item.command.commandId);
          return ack === undefined || ack.submitted ? [] : [{ item, reason: ack.reason }];
        });
        const lease = Duration.toMillis(DELIVERY_LEASE);
        const due = (item: Pending) =>
          item.handedOutAt === undefined || now - item.handedOutAt >= lease;
        const handed = kept.map((item) =>
          due(item)
            ? { ...item, handedOutAt: now, firstHandedOutAt: item.firstHandedOutAt ?? now }
            : item,
        );
        const pollerKey =
          session !== undefined && session.pollerKey === request.pollerKey
            ? session.pollerKey
            : freshKey;
        return [
          {
            _tag: "accepted",
            pollerKey,
            commands: kept.filter(due).map((item) => item.command),
            refused,
            expired,
          },
          new Map(current).set(request.sessionId, { pollerKey, lastPollAt: now, pending: handed }),
        ];
      },
    );
    // Other sessions' prompts; this session's expired ones were taken out above.
    yield* sweep();
    if (outcome._tag === "refused") return outcome;
    yield* Queue.offerAll(failures, [
      ...outcome.refused.map(({ item, reason }) => ({
        threadId: item.threadId,
        runId: item.command.commandId,
        reason: reason ?? "the terminal's claude refused it",
      })),
      ...outcome.expired.map(expiredFailure),
    ]);
    return { _tag: "accepted", pollerKey: outcome.pollerKey, commands: outcome.commands };
  });

  const directoryOf = (home: string) => path.join(home, CLAUDE_BRIDGE_CONNECTION_DIRECTORY);
  const fileOf = (home: string) => path.join(directoryOf(home), `${serverId}.json`);

  // Removes files of servers whose process is gone, left by a crash; a reused pid keeps one.
  const pruneStale = Effect.fn("ClaudeBridge.pruneStale")(function* (home: string) {
    for (const name of yield* fileSystem.readDirectory(directoryOf(home))) {
      const file = path.join(directoryOf(home), name);
      const read = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.flatMap(decodeConnection), Effect.option);
      if (read._tag === "Some" && read.value.pid !== process.pid && !isAlive(read.value.pid)) {
        yield* fileSystem.remove(file).pipe(Effect.ignore);
      }
    }
  });

  const writeConnection = Effect.fn("ClaudeBridge.writeConnection")(
    function* (home: string, origin: string) {
      yield* fileSystem.makeDirectory(directoryOf(home), { recursive: true, mode: 0o700 });
      // makeDirectory sets the mode only on a directory it creates.
      yield* fileSystem.chmod(directoryOf(home), 0o700);
      yield* pruneStale(home);
      const text = encodeConnection({
        schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
        url: `${origin}${CLAUDE_BRIDGE_ROUTE_PREFIX}`,
        token,
        proof,
        pid: process.pid,
      });
      // A fresh name created exclusively with mode 0600, so no other file or link is written.
      const pending = `${fileOf(home)}.${yield* hex(8)}.tmp`;
      yield* fileSystem.writeFileString(pending, text, { flag: "wx", mode: 0o600 });
      yield* fileSystem.rename(pending, fileOf(home));
    },
    (effect, home) =>
      effect.pipe(
        Effect.catch((cause: PlatformError.PlatformError) =>
          Effect.logWarning("Could not write the Claude bridge connection file", { home, cause }),
        ),
      ),
  );

  const registerHome: ClaudeBridge["Service"]["registerHome"] = (home) =>
    Effect.flatMap(
      Ref.modify(published, (current) => [
        current.origin,
        { ...current, homes: new Set([...current.homes, home]) },
      ]),
      (origin) => (origin === undefined ? Effect.void : writeConnection(home, origin)),
    );

  const serveAt: ClaudeBridge["Service"]["serveAt"] = (origin) =>
    Effect.flatMap(
      Ref.modify(published, (current) => [current.homes, { ...current, origin }]),
      (homes) => Effect.forEach(homes, (home) => writeConnection(home, origin), { discard: true }),
    );

  // A stopped server leaves no file pointing the mod at a port another process could take.
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(Ref.get(published), ({ homes }) =>
      Effect.forEach(homes, (home) => fileSystem.remove(fileOf(home)).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
  );
  yield* Effect.forkScoped(Effect.repeat(sweep(), Schedule.spaced(Duration.seconds(30))));

  return {
    token,
    proof,
    attached,
    submit,
    poll,
    failures,
    registerHome,
    serveAt,
  } satisfies ClaudeBridge["Service"];
});

export const layer = Layer.effect(ClaudeBridge, make);
