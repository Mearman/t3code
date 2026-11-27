import * as NodeServices from "@effect/platform-node/NodeServices";
import { CLAUDE_SESSION_FILE_CHUNK_BYTES, ClaudeSessionReplicationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type ClaudeReplicaSource,
  copyClaudeSessionFiles,
  planClaudeReplica,
} from "./ClaudeReplicaTransfer.ts";
import { listClaudeSessionFiles, sha256OfBytes } from "./ClaudeSessionFiles.ts";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const sync = (size: number, sha256: string) => ({ size, sha256 });
/** Byte equality by length and hash, whichever array type each read returns. */
const expectSameBytes = (actual: Uint8Array, expected: Uint8Array) => {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(sha256OfBytes(actual)).toBe(sha256OfBytes(expected));
};

describe("planClaudeReplica", () => {
  const owner = sync(300, "owner-300");
  const synced = sync(200, "synced-200");

  it("copies a session not held here", () => {
    expect(planClaudeReplica({ local: undefined, synced: undefined, owner })).toEqual({
      kind: "fresh",
    });
  });

  it("leaves a copy that matches its owner", () => {
    const local = { ...owner, prefixOfOwner: false, keepsSyncedPrefix: true, alreadyKept: false };
    expect(planClaudeReplica({ local, synced, owner }).kind).toBe("current");
  });

  it("brings a copy that only lacks later lines up to date from where it ends", () => {
    const local = { ...synced, prefixOfOwner: true, keepsSyncedPrefix: true, alreadyKept: false };
    expect(planClaudeReplica({ local, synced, owner })).toEqual({
      kind: "fast-forward",
      seedBytes: 200,
    });
  });

  it("lets ownership follow lines appended here while the owner stood still", () => {
    const local = {
      ...sync(260, "local-260"),
      prefixOfOwner: false,
      keepsSyncedPrefix: true,
      alreadyKept: false,
    };
    expect(planClaudeReplica({ local, synced, owner: synced }).kind).toBe("local-ahead");
  });

  it("keeps lines appended here as a session of their own once the owner moved too", () => {
    const local = {
      ...sync(260, "local-260"),
      prefixOfOwner: false,
      keepsSyncedPrefix: true,
      alreadyKept: false,
    };
    expect(planClaudeReplica({ local, synced, owner }).kind).toBe("diverged");
  });

  it("replaces a diverged copy whose own lines a fork already keeps, without forking again", () => {
    const local = {
      ...sync(260, "local-260"),
      prefixOfOwner: false,
      keepsSyncedPrefix: true,
      alreadyKept: true,
    };
    expect(planClaudeReplica({ local, synced, owner }).kind).toBe("replace");
  });

  it("treats a copy rewritten here as diverged, never as ahead", () => {
    const local = {
      ...sync(260, "local-260"),
      prefixOfOwner: false,
      keepsSyncedPrefix: false,
      alreadyKept: false,
    };
    expect(planClaudeReplica({ local, synced, owner: synced }).kind).toBe("diverged");
  });
});

it.layer(NodeServices.layer)("copyClaudeSessionFiles", (it) => {
  const homes = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const owner = path.join(root, "owner");
    const target = path.join(root, "target");
    yield* fileSystem.makeDirectory(path.join(target, "projects"), { recursive: true });
    const write = (home: string, relative: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const file = path.join(home, relative);
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFile(file, bytes);
      });
    return { root, owner, target, write };
  });

  // Bytes that differ at every offset, so a chunk written at the wrong place cannot verify.
  const bytesOf = (length: number, salt: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = (index * 31 + salt) % 251;
    return bytes;
  };

  /** Serves the owner's files as a link would, counting what it sends, failing on request. */
  const ownerSource = (ownerHome: string, failOnRequest?: number) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const counts = { requests: 0, bytes: 0 };
      const source: ClaudeReplicaSource = {
        readChunk: ({ path: relative, offset, length }) =>
          Effect.gen(function* () {
            counts.requests += 1;
            if (counts.requests === failOnRequest) {
              return yield* new ClaudeSessionReplicationError({
                reason: "unreachable",
                message: "The owner stopped answering.",
              });
            }
            const all = yield* fileSystem
              .readFile(path.join(ownerHome, relative))
              .pipe(Effect.orDie);
            counts.bytes += length;
            return all.slice(offset, offset + length);
          }),
      };
      return { source, counts };
    });

  const manifestOf = (home: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* listClaudeSessionFiles({
        layout: { projectsDir: path.join(home, "projects"), home },
        sessionId: SESSION,
        transcriptPath: path.join(home, "projects", "-owner-repo", `${SESSION}.jsonl`),
      });
    });

  const intoSlug = (relative: string) =>
    relative.replace("projects/-owner-repo/", "projects/-here/");

  const copy = (input: {
    readonly source: ClaudeReplicaSource;
    readonly targetHome: string;
    readonly manifest: Effect.Success<ReturnType<typeof manifestOf>>;
    readonly seed?: number;
  }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* copyClaudeSessionFiles({
        source: input.source,
        layout: { projectsDir: path.join(input.targetHome, "projects"), home: input.targetHome },
        sessionId: SESSION,
        transcript: {
          file: input.manifest.transcript,
          target: intoSlug(input.manifest.transcript.path),
        },
        sidecars: input.manifest.sidecars.map((file) => ({ file, target: intoSlug(file.path) })),
        seedTranscriptBytes: input.seed ?? 0,
      });
    });

  const readHere = (home: string, relative: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fileSystem.readFile(path.join(home, relative));
    });

  it.effect("makes a byte-identical copy of the transcript and every sidecar", () =>
    Effect.gen(function* () {
      const { owner, target, write } = yield* homes;
      const transcript = bytesOf(CLAUDE_SESSION_FILE_CHUNK_BYTES + 1234, 1);
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, transcript);
      yield* write(owner, `projects/-owner-repo/${SESSION}/subagents/a.jsonl`, bytesOf(500, 2));
      yield* write(owner, `file-history/${SESSION}/f@v1`, bytesOf(70, 3));
      yield* write(owner, `tasks/${SESSION}/1.json`, bytesOf(0, 4));
      const manifest = yield* manifestOf(owner);
      const { source } = yield* ownerSource(owner);

      yield* copy({ source, targetHome: target, manifest });

      for (const file of [manifest.transcript, ...manifest.sidecars]) {
        const copied = yield* readHere(target, intoSlug(file.path));
        expect(sha256OfBytes(copied)).toBe(file.sha256);
        expectSameBytes(copied, yield* readHere(owner, file.path));
      }
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* fileSystem.exists(`${target}/.t3code-replicas/${SESSION}`)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes an interrupted copy without exposing a half-written transcript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { owner, target, write } = yield* homes;
      const transcript = bytesOf(2 * CLAUDE_SESSION_FILE_CHUNK_BYTES + 99, 5);
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, transcript);
      const manifest = yield* manifestOf(owner);
      const here = `${target}/${intoSlug(manifest.transcript.path)}`;

      // The owner stops answering on the second chunk of three.
      const first = yield* ownerSource(owner, 2);
      const cut = yield* Effect.flip(copy({ source: first.source, targetHome: target, manifest }));
      expect(cut.reason).toBe("unreachable");
      expect(yield* fileSystem.exists(here)).toBe(false);

      const second = yield* ownerSource(owner);
      yield* copy({ source: second.source, targetHome: target, manifest });

      // Only what the first pass did not stage is fetched again.
      expect(second.counts.bytes).toBe(transcript.byteLength - CLAUDE_SESSION_FILE_CHUNK_BYTES);
      expectSameBytes(yield* fileSystem.readFile(here), transcript);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the previous copy whole until the update verifies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { owner, target, write } = yield* homes;
      const older = bytesOf(1000, 6);
      const newer = new Uint8Array([...older, ...bytesOf(CLAUDE_SESSION_FILE_CHUNK_BYTES + 10, 7)]);
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, newer);
      yield* write(target, `projects/-here/${SESSION}.jsonl`, older);
      const manifest = yield* manifestOf(owner);

      const cut = yield* ownerSource(owner, 2);
      yield* Effect.flip(copy({ source: cut.source, targetHome: target, manifest, seed: 1000 }));
      expectSameBytes(
        yield* fileSystem.readFile(`${target}/projects/-here/${SESSION}.jsonl`),
        older,
      );

      const resumed = yield* ownerSource(owner);
      yield* copy({ source: resumed.source, targetHome: target, manifest, seed: 1000 });
      expectSameBytes(
        yield* fileSystem.readFile(`${target}/projects/-here/${SESSION}.jsonl`),
        newer,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fetches only the lines a copy lacks when it starts from its own bytes", () =>
    Effect.gen(function* () {
      const { owner, target, write } = yield* homes;
      const older = bytesOf(5000, 8);
      const newer = new Uint8Array([...older, ...bytesOf(700, 9)]);
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, newer);
      yield* write(target, `projects/-here/${SESSION}.jsonl`, older);
      const manifest = yield* manifestOf(owner);
      const { source, counts } = yield* ownerSource(owner);

      yield* copy({ source, targetHome: target, manifest, seed: older.byteLength });

      expect(counts.bytes).toBe(700);
      expectSameBytes(yield* readHere(target, `projects/-here/${SESSION}.jsonl`), newer);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses bytes that do not hash to the owner's file and leaves the copy alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { owner, target, write } = yield* homes;
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, bytesOf(400, 10));
      const manifest = yield* manifestOf(owner);
      const corrupt: ClaudeReplicaSource = {
        readChunk: ({ length }) => Effect.succeed(bytesOf(length, 11)),
      };

      const refused = yield* Effect.flip(copy({ source: corrupt, targetHome: target, manifest }));

      expect(refused.reason).toBe("verification");
      expect(yield* fileSystem.exists(`${target}/projects/-here/${SESSION}.jsonl`)).toBe(false);
      expect(
        yield* fileSystem.exists(
          `${target}/.t3code-replicas/${SESSION}/projects/-here/${SESSION}.jsonl.part`,
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("removes sidecars the owner no longer has", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { owner, target, write } = yield* homes;
      yield* write(owner, `projects/-owner-repo/${SESSION}.jsonl`, bytesOf(10, 12));
      yield* write(target, `projects/-here/${SESSION}/tool-results/gone.txt`, bytesOf(5, 13));
      const manifest = yield* manifestOf(owner);
      const { source } = yield* ownerSource(owner);

      yield* copy({ source, targetHome: target, manifest });

      expect(
        yield* fileSystem.exists(`${target}/projects/-here/${SESSION}/tool-results/gone.txt`),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );
});
