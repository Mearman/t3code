import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeClaudeSpawnedProcesses, trackSpawnedClaudeProcess } from "./ClaudeSpawnedProcesses.ts";

describe("makeClaudeSpawnedProcesses", () => {
  it.effect("forgets a CLI once its exit runs the function registering it returned", () =>
    Effect.gen(function* () {
      const spawned = makeClaudeSpawnedProcesses(Effect.succeed([]));
      const forgetFirst = spawned.register(101);
      spawned.register(102);
      expect(yield* spawned.pids).toEqual([101, 102]);

      forgetFirst();

      expect(yield* spawned.pids).toEqual([102]);
    }),
  );
});

describe("trackSpawnedClaudeProcess", () => {
  const child = (pid?: number) =>
    Object.assign(new NodeEvents.EventEmitter(), { pid }) as NodeEvents.EventEmitter & {
      pid: number | undefined;
    };

  it.effect("counts a child from its spawn until it exits, also when the pid comes later", () =>
    Effect.gen(function* () {
      const spawned = makeClaudeSpawnedProcesses(Effect.succeed([]));
      const direct = child(201);
      trackSpawnedClaudeProcess(spawned, direct);
      const worker = child();
      trackSpawnedClaudeProcess(spawned, worker);
      expect(yield* spawned.pids).toEqual([201]);

      worker.pid = 202;
      worker.emit("spawn");
      expect(yield* spawned.pids).toEqual([201, 202]);
      direct.emit("exit");
      worker.emit("exit");

      expect(yield* spawned.pids).toEqual([]);
    }),
  );
});
