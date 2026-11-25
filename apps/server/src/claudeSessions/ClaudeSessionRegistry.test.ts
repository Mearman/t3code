import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseClaudeProcessTable } from "./ClaudeProcessTable.ts";
import {
  ClaudeSessionRegistryEntry,
  externalClaudeSessionHolders,
  readClaudeSessionRegistry,
} from "./ClaudeSessionRegistry.ts";

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ClaudeSessionRegistryEntry));

const START = "Thu Jan  1 00:00:00 2026";

const entry = (
  pid: number,
  overrides: Partial<ClaudeSessionRegistryEntry> = {},
): ClaudeSessionRegistryEntry => ({
  pid,
  sessionId: `session-${pid}`,
  cwd: "/work",
  procStart: START,
  ...overrides,
});

// 100 is the server, 101 a launcher it spawned, 102 the claude that launcher runs, 200 a terminal's.
const processes = parseClaudeProcessTable(
  [
    `  100     1   100 ${START}`,
    `  101   100   101 ${START}`,
    `  102   101   101 ${START}`,
    `  200     1   200 ${START}`,
  ].join("\n"),
);

describe("externalClaudeSessionHolders", () => {
  const holders = (entries: ReadonlyArray<ClaudeSessionRegistryEntry>) =>
    externalClaudeSessionHolders({ entries, processes, ownRootPids: [100] });

  it("excludes the server's own process tree, launcher children included", () => {
    expect([...holders([entry(101), entry(102), entry(200)]).keys()]).toEqual(["session-200"]);
  });

  it("ignores an entry whose process has exited or whose pid was reused", () => {
    expect(holders([entry(300)]).size).toBe(0);
    expect(holders([entry(200, { procStart: "Fri Jan  2 00:00:00 2026" })]).size).toBe(0);
  });

  it("keeps the more recently updated of two live entries for one session", () => {
    const current = holders([
      entry(200, { sessionId: "shared", updatedAt: 2 }),
      entry(200, { sessionId: "shared", updatedAt: 1, status: "stale" }),
    ]);
    expect(current.get("shared")?.updatedAt).toBe(2);
  });
});

it.layer(NodeServices.layer)("readClaudeSessionRegistry", (it) => {
  it.effect("reads entries, reports unrecognised ones and skips other files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(path.join(directory, "200.json"), encodeEntry(entry(200)));
      yield* fileSystem.writeFileString(path.join(directory, "201.json"), '{"pid":201}');
      yield* fileSystem.writeFileString(path.join(directory, "200.key"), "not an entry");
      yield* fileSystem.writeFileString(path.join(directory, "tmp-200"), "not an entry");

      const registry = yield* readClaudeSessionRegistry(directory);

      expect(registry.entries).toEqual([entry(200)]);
      expect(registry.unrecognised.map((error) => path.basename(error.file))).toEqual(["201.json"]);
    }),
  );

  it.effect("is empty for a home that has no registry yet", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();

      const registry = yield* readClaudeSessionRegistry(path.join(root, "sessions"));

      expect(registry).toEqual({ entries: [], unrecognised: [] });
    }),
  );
});
