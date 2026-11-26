// @effect-diagnostics nodeBuiltinImport:off - node:os gives the load average and node:fs the free disk the sync yields to.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { openLiveStreams, type LiveStreamProgress } from "../orchestration-v2/LiveStreamBudget.ts";

/** A live subscriber holding more than this share of its buffer makes the sync wait before writing more. */
const MAX_SUBSCRIBER_FULLNESS = 0.25;
const SUBSCRIBER_BACKOFF = "50 millis";
const HOST_BACKOFF = "5 seconds";

export class ClaudeSyncCapacity extends Context.Service<
  ClaudeSyncCapacity,
  {
    /** Returns once every live subscriber still reading has caught up enough to take another bounded write. */
    readonly subscribersReady: Effect.Effect<void>;
    /** Returns once the machine's load allows background work; only the sweep and the fill wait on it. */
    readonly hostIdle: Effect.Effect<void>;
    /** Free bytes on the disk holding T3 Code's data, or undefined when the platform cannot say. */
    readonly freeDiskBytes: Effect.Effect<number | undefined>;
  }
>()("t3/claudeSessions/ClaudeSyncCapacity") {}

/**
 * Returns once every live subscriber past `MAX_SUBSCRIBER_FULLNESS` has caught up below it, or acknowledged nothing for one backoff. A subscriber that stopped acknowledging is passed over until it acknowledges again, so its own budget overflows and drops it instead of one client holding every session back.
 */
export const waitForLiveSubscribers = (streams: () => ReadonlyArray<LiveStreamProgress>) => {
  const stalled = new WeakMap<LiveStreamProgress, number>();
  const behind = () =>
    streams().filter(
      (stream) =>
        stream.fullness() > MAX_SUBSCRIBER_FULLNESS && stalled.get(stream) !== stream.released(),
    );
  return Effect.gen(function* () {
    let waiting = new Map(behind().map((stream) => [stream, stream.released()]));
    while (waiting.size > 0) {
      yield* Effect.sleep(SUBSCRIBER_BACKOFF);
      const next = new Map<LiveStreamProgress, number>();
      for (const [stream, released] of waiting) {
        if (stream.fullness() <= MAX_SUBSCRIBER_FULLNESS) continue;
        if (stream.released() === released) stalled.set(stream, released);
        else next.set(stream, stream.released());
      }
      waiting = next;
    }
  });
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;

  const subscribersReady = waitForLiveSubscribers(openLiveStreams);

  // Windows reports a zero load average, so background work never waits there.
  const hostIdle = Effect.gen(function* () {
    for (;;) {
      const [oneMinute] = NodeOS.loadavg();
      if (oneMinute === undefined || oneMinute < NodeOS.availableParallelism()) return;
      yield* Effect.sleep(HOST_BACKOFF);
    }
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
