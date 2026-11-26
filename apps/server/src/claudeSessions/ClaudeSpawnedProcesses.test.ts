import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeClaudeSpawnedProcesses, trackSpawnedClaudeProcess } from "./ClaudeSpawnedProcesses.ts";

// `/linked` is a symlink to the `/work` registry; any other path is its own.
const spawnedProcesses = () =>
  makeClaudeSpawnedProcesses(Effect.succeed([]), (path) =>
    Effect.succeed(path === "/linked" ? "/work" : path),
  );

describe("makeClaudeSpawnedProcesses", () => {
  it.effect("forgets a CLI once its exit runs the function registering it returned", () =>
    Effect.gen(function* () {
      const spawned = spawnedProcesses();
      const forgetFirst = spawned.register(101, "/work");
      spawned.register(102, "/work");
      expect(yield* spawned.pids("/work")).toEqual([101, 102]);

      forgetFirst();

      expect(yield* spawned.pids("/work")).toEqual([102]);
    }),
  );

  it.effect("lists only the CLIs writing to the registry asked about, by any path to it", () =>
    Effect.gen(function* () {
      const spawned = spawnedProcesses();
      spawned.register(101, "/work");
      spawned.register(102, "/linked");
      spawned.register(103, "/personal");

      expect(yield* spawned.pids("/work")).toEqual([101, 102]);
      expect(yield* spawned.pids("/linked")).toEqual([101, 102]);
      expect(yield* spawned.pids("/personal")).toEqual([103]);
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
      const spawned = spawnedProcesses();
      const direct = child(201);
      trackSpawnedClaudeProcess(spawned, direct, "/work");
      const worker = child();
      trackSpawnedClaudeProcess(spawned, worker, "/work");
      expect(yield* spawned.pids("/work")).toEqual([201]);

      worker.pid = 202;
      worker.emit("spawn");
      expect(yield* spawned.pids("/work")).toEqual([201, 202]);
      direct.emit("exit");
      worker.emit("exit");

      expect(yield* spawned.pids("/work")).toEqual([]);
    }),
  );
});
