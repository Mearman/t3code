// @effect-diagnostics nodeBuiltinImport:off - node:os gives the load average, node:perf_hooks the event loop utilisation and node:fs the free disk the sync yields to.
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

/** At most this many sync steps a second, so even an idle machine reads its backlog gradually. */
const MIN_STEP_MS = 100;
/** The server's own event loop busier than this, over the time since the last step, holds the sync back. */
const MAX_EVENT_LOOP_UTILISATION = 0.5;
const BUSY_BACKOFF = "5 seconds";

export class ClaudeSyncCapacity extends Context.Service<
  ClaudeSyncCapacity,
  {
    /** Returns once the machine and this server have room for one more bounded sync step. */
    readonly wait: Effect.Effect<void>;
    /** Free bytes on the disk holding T3 Code's data, or undefined when the platform cannot say. */
    readonly freeDiskBytes: Effect.Effect<number | undefined>;
  }
>()("t3/claudeSessions/ClaudeSyncCapacity") {}

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  let since = NodePerfHooks.performance.eventLoopUtilization();
  let sinceAt = NodePerfHooks.performance.now();

  const busy = Effect.gen(function* () {
    const elapsed = NodePerfHooks.performance.now() - sinceAt;
    if (elapsed < MIN_STEP_MS) yield* Effect.sleep(`${Math.ceil(MIN_STEP_MS - elapsed)} millis`);
    const utilisation = NodePerfHooks.performance.eventLoopUtilization(since).utilization;
    since = NodePerfHooks.performance.eventLoopUtilization();
    sinceAt = NodePerfHooks.performance.now();
    // Windows reports a zero load average, so there only the event loop is read.
    const [oneMinute] = NodeOS.loadavg();
    return (
      utilisation >= MAX_EVENT_LOOP_UTILISATION ||
      (oneMinute !== undefined && oneMinute >= NodeOS.availableParallelism())
    );
  });

  const wait = Effect.gen(function* () {
    while (yield* busy) yield* Effect.sleep(BUSY_BACKOFF);
  });

  const freeDiskBytes = Effect.tryPromise(() => NodeFS.statfs(stateDir)).pipe(
    Effect.map((stats) => Number(stats.bavail) * Number(stats.bsize)),
    Effect.orElseSucceed(() => undefined),
  );

  return ClaudeSyncCapacity.of({ wait, freeDiskBytes });
});

export const layer = Layer.effect(ClaudeSyncCapacity, make);
