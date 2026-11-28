import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectSlug,
  claudeReplicaBytesNeeded,
  claudeReplicaFitsReserve,
  isClaudeSessionFilePath,
  listClaudeSessionFiles,
  resolveServedClaudeSessionFile,
  sha256OfBytes,
} from "./ClaudeSessionFiles.ts";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const OTHER = "1c8a7b63-4d2e-4f90-8b3c-6d7e8f9a0b1c";

describe("claudeProjectSlug", () => {
  it("replaces every character but letters and digits, as Claude Code names project folders", () => {
    expect(claudeProjectSlug("/Users/me/Developer/my_repo.v2")).toBe(
      "-Users-me-Developer-my-repo-v2",
    );
  });

  it("cuts a long name at 200 characters and suffixes a hash of the whole path", () => {
    const deep = `/${"segment/".repeat(40)}end`;
    const slug = claudeProjectSlug(deep);
    expect(slug.slice(0, 200)).toBe(deep.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
    expect(slug).toMatch(/^.{200}-[0-9a-z]+$/);
    expect(claudeProjectSlug(`${deep}x`)).not.toBe(slug);
  });
});

describe("isClaudeSessionFilePath", () => {
  it.each([
    `projects/-repo/${SESSION}.jsonl`,
    `projects/-repo/${SESSION}/subagents/agent-1.jsonl`,
    `projects/-repo/${SESSION}/tool-results/abc.txt`,
    `projects/-repo/${SESSION}/mcp-tasks/task.json`,
    `file-history/${SESSION}/deadbeef@v1`,
    `tasks/${SESSION}/1.json`,
  ])("accepts the session's own file %s", (relative) => {
    expect(isClaudeSessionFilePath(SESSION, relative)).toBe(true);
  });

  it.each([
    ".credentials.json",
    "settings.json",
    "sessions/123.json",
    `projects/-repo/${OTHER}.jsonl`,
    `projects/-repo/${SESSION}.jsonl.bak`,
    `projects/-repo/${OTHER}/subagents/a.jsonl`,
    `projects/-repo/../${SESSION}.jsonl`,
    `file-history/${SESSION}/../../.credentials.json`,
    `file-history/${SESSION}`,
    `tasks/${OTHER}/1.json`,
    `/etc/${SESSION}.jsonl`,
    `projects//${SESSION}.jsonl`,
  ])("refuses %s, which is not one of the session's files", (relative) => {
    expect(isClaudeSessionFilePath(SESSION, relative)).toBe(false);
  });
});

it("keeps the reserve: a copy fits only while the reserve stays free", () => {
  const gib = 1024 ** 3;
  expect(claudeReplicaFitsReserve({ freeBytes: 21 * gib, neededBytes: gib, reserveGiB: 20 })).toBe(
    true,
  );
  expect(
    claudeReplicaFitsReserve({ freeBytes: 21 * gib, neededBytes: gib + 1, reserveGiB: 20 }),
  ).toBe(false);
});

it("counts the whole transcript and every sidecar not already present toward the reserve", () => {
  // A fast-forward stages a full copy, seeded with the local prefix, beside the old one.
  expect(
    claudeReplicaBytesNeeded({
      transcriptBytes: 1000,
      sidecars: [
        { size: 10, presentSize: 10 },
        { size: 20, presentSize: 5 },
        { size: 30, presentSize: undefined },
      ],
    }),
  ).toBe(1050);
});

it.layer(NodeServices.layer)("session files on disk", (it) => {
  const makeHome = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const projectsDir = path.join(home, "projects");
    const write = (relative: string, text: string) =>
      Effect.gen(function* () {
        const target = path.join(home, relative);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFileString(target, text);
      });
    yield* write(`projects/-repo/${SESSION}.jsonl`, '{"type":"user"}\n');
    yield* write(`projects/-repo/${SESSION}/subagents/agent-1.jsonl`, "sub\n");
    yield* write(`projects/-repo/${SESSION}/tool-results/out.txt`, "out");
    yield* write(`file-history/${SESSION}/abc@v1`, "before");
    yield* write(`tasks/${SESSION}/1.json`, "{}");
    // Nothing else in the home may ever be listed or served.
    yield* write(".credentials.json", "secret");
    yield* write("settings.json", "{}");
    yield* write(`projects/-repo/${OTHER}.jsonl`, "other\n");
    yield* write(`file-history/${OTHER}/abc@v1`, "other");
    return {
      home,
      layout: { projectsDir, home },
      transcriptPath: path.join(projectsDir, "-repo", `${SESSION}.jsonl`),
    };
  });

  it.effect("lists only the session's transcript and sidecars, each with its hash", () =>
    Effect.gen(function* () {
      const { layout, transcriptPath } = yield* makeHome;
      const files = yield* listClaudeSessionFiles({ layout, sessionId: SESSION, transcriptPath });
      expect(files.transcript).toEqual({
        path: `projects/-repo/${SESSION}.jsonl`,
        size: 16,
        sha256: sha256OfBytes(new TextEncoder().encode('{"type":"user"}\n')),
      });
      expect(files.sidecars.map((file) => file.path)).toEqual([
        `projects/-repo/${SESSION}/subagents/agent-1.jsonl`,
        `projects/-repo/${SESSION}/tool-results/out.txt`,
        `file-history/${SESSION}/abc@v1`,
        `tasks/${SESSION}/1.json`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("never serves a path outside the session, through a symlink either", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, layout, transcriptPath } = yield* makeHome;
      yield* fileSystem.symlink(
        path.join(home, ".credentials.json"),
        path.join(home, "file-history", SESSION, "escape"),
      );
      const serve = (relativePath: string) =>
        resolveServedClaudeSessionFile({
          layout,
          sessionId: SESSION,
          transcriptPath,
          relativePath,
        });

      expect(yield* serve(`file-history/${SESSION}/abc@v1`)).toBe(
        path.join(home, "file-history", SESSION, "abc@v1"),
      );
      expect(yield* serve(`projects/-repo/${SESSION}.jsonl`)).toBe(transcriptPath);
      expect(yield* serve(`file-history/${SESSION}/escape`)).toBeUndefined();
      expect(yield* serve(`projects/-elsewhere/${SESSION}.jsonl`)).toBeUndefined();
      expect(yield* serve(".credentials.json")).toBeUndefined();
      // A sidecar may not reach another session's transcript in the same project folder.
      yield* fileSystem.symlink(
        path.join(home, "projects", "-repo", `${OTHER}.jsonl`),
        path.join(home, "projects", "-repo", SESSION, "other.jsonl"),
      );
      expect(yield* serve(`projects/-repo/${SESSION}/other.jsonl`)).toBeUndefined();
      expect(yield* serve(`projects/-repo/${OTHER}.jsonl`)).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
