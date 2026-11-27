import {
  CLAUDE_BRIDGE_CONNECTION_FILE,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

// A poll is held this long when nothing is queued, so an idle mod asks about twice a minute.
export const CLAUDE_BRIDGE_POLL_HOLD = Duration.seconds(25);
// A mod counts as attached while a poll is open or ended within this long.
const ATTACHED_GRACE_MILLIS = Duration.toMillis(Duration.seconds(10));

interface Attachment {
  readonly commands: Queue.Queue<ClaudeBridgeCommand>;
  readonly openPolls: number;
  readonly lastPollAt: number;
}

/**
 * Sessions whose `claude` runs the T3 bridge mod, and the commands waiting for each. Only a mod holding the token from the connection file reaches it; see `ClaudeBridgeHttp`.
 */
export class ClaudeBridge extends Context.Service<
  ClaudeBridge,
  {
    readonly token: string;
    /** Whether a mod polled for `sessionId` recently, or is polling now. */
    readonly attached: (sessionId: string) => Effect.Effect<boolean>;
    /** Queues a prompt for the mod; `asUser` only for a person's own words. */
    readonly submit: (input: {
      readonly sessionId: string;
      readonly commandId: string;
      readonly text: string;
      readonly asUser: boolean;
    }) => Effect.Effect<void>;
    /** A mod's poll: waits up to `CLAUDE_BRIDGE_POLL_HOLD` for commands for its session. */
    readonly poll: (poll: ClaudeBridgePoll) => Effect.Effect<ReadonlyArray<ClaudeBridgeCommand>>;
    /** A Claude home whose sessions may load the mod; it gets the connection file. */
    readonly registerHome: (home: string) => Effect.Effect<void>;
    /** The server's loopback origin once it listens; every registered home gets the file. */
    readonly serveAt: (origin: string) => Effect.Effect<void>;
  }
>()("t3/claudeSessions/ClaudeBridge") {}

const encodeConnection = Schema.encodeSync(Schema.fromJsonString(ClaudeBridgeConnection));

export const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const published = yield* Ref.make<{
    readonly origin: string | undefined;
    readonly homes: ReadonlySet<string>;
  }>({ origin: undefined, homes: new Set() });
  const token = Buffer.from(yield* random.randomBytes(32)).toString("hex");
  const sessions = yield* Ref.make(new Map<string, Attachment>());

  const attachment = Effect.fnUntraced(function* (sessionId: string) {
    const known = (yield* Ref.get(sessions)).get(sessionId);
    if (known !== undefined) return known;
    const created: Attachment = {
      commands: yield* Queue.unbounded<ClaudeBridgeCommand>(),
      openPolls: 0,
      lastPollAt: 0,
    };
    return yield* Ref.modify(sessions, (current) => {
      const raced = current.get(sessionId);
      if (raced !== undefined) return [raced, current] as const;
      return [created, new Map(current).set(sessionId, created)] as const;
    });
  });
  const update = (sessionId: string, change: (current: Attachment) => Attachment) =>
    Ref.update(sessions, (current) => {
      const known = current.get(sessionId);
      return known === undefined ? current : new Map(current).set(sessionId, change(known));
    });

  const attached: ClaudeBridge["Service"]["attached"] = Effect.fn("ClaudeBridge.attached")(
    function* (sessionId) {
      const known = (yield* Ref.get(sessions)).get(sessionId);
      if (known === undefined) return false;
      if (known.openPolls > 0) return true;
      return (yield* Clock.currentTimeMillis) - known.lastPollAt <= ATTACHED_GRACE_MILLIS;
    },
  );

  const submit: ClaudeBridge["Service"]["submit"] = (input) =>
    Effect.flatMap(attachment(input.sessionId), (known) =>
      Queue.offer(known.commands, {
        type: "submit",
        commandId: input.commandId,
        text: claudeBridgePromptText(input.text, input.asUser),
        asUser: input.asUser,
      }),
    ).pipe(Effect.asVoid);

  const poll: ClaudeBridge["Service"]["poll"] = Effect.fn("ClaudeBridge.poll")(function* (request) {
    const known = yield* attachment(request.sessionId);
    const now = yield* Clock.currentTimeMillis;
    yield* update(request.sessionId, (current) => ({
      ...current,
      openPolls: current.openPolls + 1,
      lastPollAt: now,
    }));
    const taken = yield* Queue.takeAll(known.commands).pipe(
      Effect.timeoutOption(CLAUDE_BRIDGE_POLL_HOLD),
      Effect.ensuring(
        Effect.flatMap(Clock.currentTimeMillis, (ended) =>
          update(request.sessionId, (current) => ({
            ...current,
            openPolls: current.openPolls - 1,
            lastPollAt: ended,
          })),
        ),
      ),
    );
    return Option.getOrElse(taken, () => []);
  });

  const writeConnection = (home: string, origin: string) =>
    Effect.gen(function* () {
      const file = path.join(home, CLAUDE_BRIDGE_CONNECTION_FILE);
      const text = encodeConnection({
        schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
        url: `${origin}${CLAUDE_BRIDGE_ROUTE_PREFIX}`,
        token,
      });
      // The mode is set before the rename, so the file is never readable by others under its name.
      const pending = `${file}.${process.pid}.tmp`;
      yield* fileSystem.writeFileString(pending, text, { mode: 0o600 });
      yield* fileSystem.chmod(pending, 0o600);
      yield* fileSystem.rename(pending, file);
    }).pipe(
      Effect.catch((cause: PlatformError.PlatformError) =>
        Effect.logWarning("Could not write the Claude bridge connection file", { home, cause }),
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

  return {
    token,
    attached,
    submit,
    poll,
    registerHome,
    serveAt,
  } satisfies ClaudeBridge["Service"];
});

export const layer = Layer.effect(ClaudeBridge, make);
