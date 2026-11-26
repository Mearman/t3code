import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ClaudeLiveSessions from "./ClaudeLiveSessions.ts";
import { parseClaudeProcessTable } from "./ClaudeProcessTable.ts";
import { ClaudeSpawnedProcesses, makeClaudeSpawnedProcesses } from "./ClaudeSpawnedProcesses.ts";

const SESSION = "00000000-0000-4000-8000-0000000000bb";

/** `ps -o lstart=` for a pid, in the C locale and UTC, as Claude Code records it. */
const startOf = (pid: number) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.make();
    const result = yield* runner.run({
      command: "ps",
      args: ["-o", "lstart=", "-p", String(pid)],
      env: { LC_ALL: "C", TZ: "UTC0" },
      timeout: "5 seconds",
    });
    return result.stdout.trim();
  });

const entry = Effect.fn(function* (dir: string, pid: number, procStart: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: SESSION, cwd: "/work", procStart }),
  );
});

describe("ClaudeLiveSessions", () => {
  it.effect("counts a live holder T3 Code did not spawn, not a stale entry or a spawned CLI", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner.make();
      const table = runner
        .run({
          command: "ps",
          args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
          env: { LC_ALL: "C", TZ: "UTC0" },
          timeout: "5 seconds",
        })
        .pipe(
          Effect.map((result) => parseClaudeProcessTable(result.stdout)),
          Effect.orDie,
        );
      // The send gate's record of CLIs T3 Code spawned; this test process stands in for one.
      const spawned = makeClaudeSpawnedProcesses(table, fileSystem.realPath);
      const read = (dir: string) =>
        ClaudeLiveSessions.ClaudeLiveSessions.use((live) => live.read(dir)).pipe(
          Effect.provide(ClaudeLiveSessions.layer),
          Effect.provideService(ClaudeSpawnedProcesses, spawned),
        );

      const stale = yield* fileSystem.makeTempDirectoryScoped();
      // A pid Claude recorded with another start time, as a crashed process's reused pid has.
      yield* entry(stale, process.ppid, "Thu Jan  1 00:00:00 1970");
      expect([...(yield* read(stale))]).toEqual([]);

      // A CLI T3 Code spawned for this registry is its own, as the send gate counts it.
      const own = yield* fileSystem.makeTempDirectoryScoped();
      yield* entry(own, process.ppid, yield* startOf(process.ppid));
      const forget = spawned.register(process.ppid, own);
      expect([...(yield* read(own))]).toEqual([]);
      forget();

      const held = yield* fileSystem.makeTempDirectoryScoped();
      yield* entry(held, process.ppid, yield* startOf(process.ppid));
      expect([...(yield* read(held))]).toEqual([SESSION]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
