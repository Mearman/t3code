// @effect-diagnostics nodeBuiltinImport:off - node:crypto mints the line uuids a transcript holds.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PortScanner from "../preview/PortScanner.ts";

import { copyClaudeSessionFiles } from "./ClaudeReplicaTransfer.ts";
import { listClaudeSessionFiles } from "./ClaudeSessionFiles.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const CWD = "/work/repo";
const SLUG = "-work-repo";

const jsonl = (lines: ReadonlyArray<object>) =>
  lines.map((line) => `${JSON.stringify({ sessionId: SESSION, cwd: CWD, ...line })}\n`).join("");

const textOfBlock = (block: unknown) =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "text" &&
  "text" in block &&
  typeof block.text === "string"
    ? [block.text]
    : [];

/** Every prompt and reply text in a transcript, in file order. */
const textsIn = (transcript: string) =>
  transcript
    .trim()
    .split("\n")
    .flatMap((raw): ReadonlyArray<string> => {
      const line: unknown = JSON.parse(raw);
      if (typeof line !== "object" || line === null || !("message" in line)) return [];
      const message = line.message;
      const content =
        typeof message === "object" && message !== null && "content" in message
          ? message.content
          : undefined;
      if (typeof content === "string") return [content];
      return Array.isArray(content) ? content.flatMap(textOfBlock) : [];
    });

// The runner forks in a worker given the replica's home, as replication calls it.
const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.layer(
  forkRunnerLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
  ),
)("divergent copies", (it) => {
  it.effect(
    "give two sessions, the owner's under its id and the copy's lines forked, losing none",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const owner = path.join(root, "owner");
        const replica = path.join(root, "replica");
        const transcript = `projects/${SLUG}/${SESSION}.jsonl`;
        const t = claudeTranscriptFixture();
        const id = () => NodeCrypto.randomUUID();
        const [p1, a1, p2, a2, p3, a3] = [id(), id(), id(), id(), id(), id()];
        const shared = [t.prompt(p1, null, "shared question"), t.text(a1, p1, "shared answer")];
        const ownerLines = [
          ...shared,
          t.prompt(p2, a1, "asked on the owner"),
          t.text(a2, p2, "owner reply"),
        ];
        const copyLines = [
          ...shared,
          t.prompt(p3, a1, "asked on the copy"),
          t.text(a3, p3, "copy reply"),
        ];
        for (const [home, lines] of [
          [owner, ownerLines],
          [replica, copyLines],
        ] as const) {
          yield* fileSystem.makeDirectory(path.join(home, "projects", SLUG), { recursive: true });
          yield* fileSystem.writeFileString(path.join(home, transcript), jsonl(lines));
        }

        // What replication does with a diverged copy: fork the copy's lines, then take the owner's.
        const runner = yield* ClaudeAgentSdkQueryRunner;
        const forked = yield* runner.forkSession({
          sessionId: SESSION,
          options: { dir: CWD },
          environment: { ...(yield* HostProcess.Environment), CLAUDE_CONFIG_DIR: replica },
          threadId: ThreadId.make("claude:divergence"),
          providerSessionId: ProviderSessionId.make("claude-replica:divergence"),
        });
        const manifest = yield* listClaudeSessionFiles({
          layout: { projectsDir: path.join(owner, "projects"), home: owner },
          sessionId: SESSION,
          transcriptPath: path.join(owner, transcript),
        });
        yield* copyClaudeSessionFiles({
          source: {
            readChunk: ({ path: relative, offset, length }) =>
              fileSystem.readFile(path.join(owner, relative)).pipe(
                Effect.map((bytes) => bytes.slice(offset, offset + length)),
                Effect.orDie,
              ),
          },
          layout: { projectsDir: path.join(replica, "projects"), home: replica },
          sessionId: SESSION,
          transcript: { file: manifest.transcript, target: transcript },
          sidecars: [],
          seedTranscriptBytes: 0,
        });

        expect(forked.sessionId).not.toBe(SESSION);
        expect(Buffer.from(yield* fileSystem.readFile(path.join(replica, transcript)))).toEqual(
          Buffer.from(yield* fileSystem.readFile(path.join(owner, transcript))),
        );
        const read = (sessionId: string) =>
          fileSystem.readFileString(path.join(replica, "projects", SLUG, `${sessionId}.jsonl`));
        const kept = textsIn(yield* read(SESSION));
        const fork = textsIn(yield* read(forked.sessionId));
        expect(kept).toEqual([
          "shared question",
          "shared answer",
          "asked on the owner",
          "owner reply",
        ]);
        expect(fork).toEqual([
          "shared question",
          "shared answer",
          "asked on the copy",
          "copy reply",
        ]);
      }).pipe(Effect.scoped),
  );
});
