// @effect-diagnostics nodeBuiltinImport:off - node:os gives the load average and node:fs the free disk the sync yields to.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { openLiveStreams, type LiveStreamProgress } from "../orchestration-v2/LiveStreamBudget.ts";

/** A live subscriber holding more than this share of its buffer makes the sync wait before writing more. */
const MAX_SUBSCRIBER_FULLNESS = 0.25;
const SUBSCRIBER_BACKOFF = "50 millis";
/** A subscriber that acknowledges nothing this long is stalled: many round trips of a slow mobile or relay link. */
const SUBSCRIBER_STALL_WINDOW = Duration.seconds(10);

export class ClaudeSyncCapacity extends Context.Service<
  ClaudeSyncCapacity,
  {
    /** Returns once every live subscriber still reading has caught up enough to take another bounded write. */
    readonly subscribersReady: Effect.Effect<void>;
    /** Whether the machine's load allows background work now; only the fill asks, and it never waits. */
    readonly hostIdle: Effect.Effect<boolean>;
    /** Free bytes on the disk holding T3 Code's data, or undefined when the platform cannot say. */
    readonly freeDiskBytes: Effect.Effect<number | undefined>;
  }
>()("t3/claudeSessions/ClaudeSyncCapacity") {}

/**
 * Returns once every live subscriber past `MAX_SUBSCRIBER_FULLNESS` has caught up below it. One that acknowledges nothing for `SUBSCRIBER_STALL_WINDOW` is judged stalled and passed over until it acknowledges again, so its own budget overflows and drops it instead of one client holding every session back. The window spans many round trips of a slow link, so a client that is reading, however slowly, is always waited for.
 */
export const waitForLiveSubscribers = (streams: () => ReadonlyArray<LiveStreamProgress>) => {
  // The release count each subscriber was judged stalled at.
  const stalled = new WeakMap<LiveStreamProgress, number>();
  return Effect.gen(function* () {
    // Each subscriber still behind, with its release count and when that count last changed.
    const watched = new Map<LiveStreamProgress, { released: number; since: number }>();
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const behind = streams().filter(
        (stream) =>
          stream.fullness() > MAX_SUBSCRIBER_FULLNESS && stalled.get(stream) !== stream.released(),
      );
      if (behind.length === 0) return;
      for (const stream of behind) {
        const released = stream.released();
        const known = watched.get(stream);
        if (known === undefined || known.released !== released) {
          watched.set(stream, { released, since: now });
        } else if (now - known.since >= Duration.toMillis(SUBSCRIBER_STALL_WINDOW)) {
          stalled.set(stream, released);
        }
      }
      yield* Effect.sleep(SUBSCRIBER_BACKOFF);
    }
  });
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;

  const subscribersReady = waitForLiveSubscribers(openLiveStreams);

  // Windows reports a zero load average, so background work is never held back there.
  const hostIdle = Effect.sync(() => {
    const [oneMinute] = NodeOS.loadavg();
    return oneMinute === undefined || oneMinute < NodeOS.availableParallelism();
  });

  // A platform that cannot report free space does not hold the sync back.
  const freeDiskBytes = Effect.tryPromise({
    try: () => NodeFSP.statfs(stateDir),
    catch: () => undefined,
  }).pipe(
    Effect.map((stats): number | undefined => Number(stats.bavail) * Number(stats.bsize)),
    Effect.orElseSucceed(() => undefined),
  );

  return ClaudeSyncCapacity.of({ subscribersReady, hostIdle, freeDiskBytes });
});

export const layer = Layer.effect(ClaudeSyncCapacity, make);
