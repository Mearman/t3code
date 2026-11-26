import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeClaudeSpawnedProcesses } from "./ClaudeSpawnedProcesses.ts";

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
