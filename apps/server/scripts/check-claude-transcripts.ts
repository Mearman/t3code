// @effect-diagnostics nodeBuiltinImport:off - a maintenance script that walks a transcript tree.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { readClaudeTranscriptTurn } from "../src/claudeSessions/ClaudeTranscriptContent.ts";
import {
  ClaudeTranscriptIndex,
  claudeTranscriptSessionId,
  syncClaudeTranscriptIndex,
} from "../src/claudeSessions/ClaudeTranscriptIndex.ts";
import {
  checkClaudeTranscriptTurns,
  type ClaudeTranscriptViolation,
} from "../src/claudeSessions/ClaudeTranscriptInvariants.ts";
import {
  claudeTranscriptStructure,
  type ClaudeTranscriptStructure,
} from "../src/claudeSessions/ClaudeTranscriptTurns.ts";

const USAGE = `Checks the Claude transcript parser against real transcripts, printing counts and line shapes only.

  node apps/server/scripts/check-claude-transcripts.ts [root] [--files N] [--splits N] [--permutations N] [--seed N] [--max-mib N]
  node --expose-gc apps/server/scripts/check-claude-transcripts.ts --synthetic-mib N [--payload-bytes N]

root defaults to ~/.claude/projects. Exits 1 when no transcript was checked or any invariant is broken.
--synthetic-mib writes a synthetic transcript of that size and reports what indexing it holds and reads.`;

interface Options {
  readonly root: string;
  readonly files: number;
  readonly splits: number;
  readonly permutations: number;
  readonly seed: number;
  readonly maxFileBytes: number;
  readonly syntheticMib: number | undefined;
  readonly payloadBytes: number;
}

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  reason: Schema.String,
}) {}

const parseOptions = Effect.fn("checkClaudeTranscripts.parseOptions")(function* (
  argv: ReadonlyArray<string>,
) {
  const optional = Effect.fnUntraced(function* (name: string) {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const parsed = Number(argv[index + 1]);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return yield* new UsageError({ reason: `${name} takes a whole number of at least 1.` });
    }
    return parsed;
  });
  const valueOf = Effect.fnUntraced(function* (name: string, fallback: number) {
    const parsed = yield* optional(name);
    return parsed === undefined ? fallback : parsed;
  });
  const root = argv.find(
    (arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"),
  );
  const files = yield* optional("--files");
  const options: Options = {
    root: root ?? NodePath.join(NodeOS.homedir(), ".claude", "projects"),
    files: files === undefined ? Number.POSITIVE_INFINITY : files,
    splits: yield* valueOf("--splits", 6),
    permutations: yield* valueOf("--permutations", 2),
    seed: yield* valueOf("--seed", 1),
    maxFileBytes: (yield* valueOf("--max-mib", 256)) * 1024 * 1024,
    syntheticMib: yield* optional("--synthetic-mib"),
    payloadBytes: yield* valueOf("--payload-bytes", 1024),
  };
  return options;
});

// A small deterministic generator, so a failing split or permutation is reproduced from its seed.
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % Math.max(1, bound);
  };
}

function transcriptsUnder(root: string): Array<string> {
  const found: Array<string> = [];
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && claudeTranscriptSessionId(entry.name) !== undefined)
        found.push(path);
    }
  };
  walk(root);
  return found.toSorted();
}

const encodeReport = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

function uuidOf(line: string): string | undefined {
  try {
    const record: unknown = JSON.parse(line);
    const uuid =
      typeof record === "object" && record !== null ? Reflect.get(record, "uuid") : undefined;
    return typeof uuid === "string" ? uuid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lines in a random order that keeps every uuid's first line before its later copies: the first lines and the lines without a uuid are shuffled, and the copies follow in their own order.
 */
function permuted(lines: ReadonlyArray<string>, next: (bound: number) => number): Array<string> {
  const seen = new Set<string>();
  const firsts: Array<string> = [];
  const copies: Array<string> = [];
  for (const line of lines) {
    const uuid = uuidOf(line);
    if (uuid !== undefined && seen.has(uuid)) copies.push(line);
    else firsts.push(line);
    if (uuid !== undefined) seen.add(uuid);
  }
  for (let index = firsts.length - 1; index > 0; index--) {
    const other = next(index + 1);
    const swap = firsts[index];
    const with_ = firsts[other];
    if (swap === undefined || with_ === undefined) continue;
    firsts[index] = with_;
    firsts[other] = swap;
  }
  return [...firsts, ...copies];
}

function indexLines(lines: ReadonlyArray<string>): ClaudeTranscriptIndex {
  const index = new ClaudeTranscriptIndex();
  let offset = 0;
  for (const line of lines) {
    const bytes = encoder.encode(line);
    index.addLine(bytes, offset);
    offset += bytes.length + 1;
  }
  return index;
}

const checkFile = Effect.fn("checkClaudeTranscripts.checkFile")(function* (
  filePath: string,
  options: Options,
  seed: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-transcript-check-" });
  // One snapshot of the bytes: a live transcript can grow while it is checked.
  const bytes = yield* fileSystem.readFile(filePath);
  const complete = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
  const lines = new TextDecoder().decode(complete).split("\n").slice(0, -1);
  const snapshot = NodePath.join(scratch, "whole.jsonl");
  yield* fileSystem.writeFile(snapshot, complete);

  const index = new ClaudeTranscriptIndex();
  yield* syncClaudeTranscriptIndex({ filePath: snapshot, index });
  const structure = claudeTranscriptStructure(index);
  const contents = [];
  for (const turn of structure.turns) {
    contents.push(
      yield* readClaudeTranscriptTurn({ filePath: snapshot, index, idScope: "check", turn }),
    );
  }

  // The same bytes appended in random pieces that can end mid-line, synced after each piece.
  const next = random(seed);
  const growing = NodePath.join(scratch, "growing.jsonl");
  yield* fileSystem.writeFile(growing, new Uint8Array(0));
  const cuts = Array.from({ length: options.splits - 1 }, () => next(complete.length)).toSorted(
    (left, right) => left - right,
  );
  const split = new ClaudeTranscriptIndex();
  let written = 0;
  for (const cut of [...cuts, complete.length]) {
    NodeFS.appendFileSync(growing, complete.subarray(written, cut));
    written = cut;
    const synced = yield* syncClaudeTranscriptIndex({ filePath: growing, index: split });
    if (synced.rebuilt) return yield* Effect.die("An appended transcript was taken as rewritten.");
  }
  const others: Array<{ readonly name: string; readonly structure: ClaudeTranscriptStructure }> = [
    { name: "split read", structure: claudeTranscriptStructure(split) },
  ];
  // File order legitimately decides the titles and derivation, so they come from the whole read.
  for (let round = 0; round < options.permutations; round++) {
    const shuffled = claudeTranscriptStructure(indexLines(permuted(lines, next)));
    others.push({
      name: `permutation ${round}`,
      structure: {
        ...shuffled,
        aiTitle: structure.aiTitle,
        customTitle: structure.customTitle,
        derivedFrom: structure.derivedFrom,
      },
    });
  }
  return checkClaudeTranscriptTurns({ lines, structure, contents, others });
}, Effect.scoped);

// Lines shaped like Claude Code's, with a reply written before its prompt and a replayed line.
function* syntheticTurns(payloadBytes: number) {
  const pad = "x".repeat(payloadBytes);
  let previous: string | null = null;
  let at = Date.parse("2026-01-01T00:00:00.000Z");
  for (let turn = 0; ; turn++) {
    const stamp = () => {
      at += 7;
      return DateTime.formatIso(DateTime.makeUnsafe(at));
    };
    const id = (part: string) =>
      `00000000-0000-4000-8000-${turn.toString(16).padStart(8, "0")}${part}`;
    const prompt = id("0001");
    const [opener, thinking, call, ...rest] = [
      {
        type: "user",
        uuid: prompt,
        parentUuid: previous,
        timestamp: stamp(),
        promptId: id("p000"),
        message: { role: "user", content: `Prompt ${turn} ${pad.slice(0, 200)}` },
      },
      {
        type: "assistant",
        uuid: id("0002"),
        parentUuid: prompt,
        timestamp: stamp(),
        message: {
          id: id("m001"),
          model: "claude-test",
          role: "assistant",
          content: [{ type: "thinking", thinking: pad, signature: "s" }],
          stop_reason: null,
        },
      },
      {
        type: "assistant",
        uuid: id("0003"),
        parentUuid: id("0002"),
        timestamp: stamp(),
        message: {
          id: id("m001"),
          model: "claude-test",
          role: "assistant",
          content: [{ type: "tool_use", id: id("t001"), name: "Bash", input: { command: "ls" } }],
          stop_reason: "tool_use",
        },
      },
      {
        type: "user",
        uuid: id("0004"),
        parentUuid: id("0003"),
        timestamp: stamp(),
        promptId: id("p000"),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id("t001"), content: pad }],
        },
      },
      ...(turn % 7 === 3
        ? [
            {
              type: "attachment",
              uuid: id("0005"),
              parentUuid: id("0004"),
              timestamp: stamp(),
              attachment: { type: "queued_command", prompt: "Also this", commandMode: "prompt" },
            },
          ]
        : []),
      {
        type: "assistant",
        uuid: id("0006"),
        parentUuid: turn % 7 === 3 ? id("0005") : id("0004"),
        timestamp: stamp(),
        message: {
          id: id("m002"),
          model: "claude-test",
          role: "assistant",
          content: [{ type: "text", text: pad }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "system",
        subtype: "turn_duration",
        uuid: id("0007"),
        parentUuid: id("0006"),
        timestamp: stamp(),
        durationMs: 1200,
      },
    ];
    // Claude Code writes some replies before their parent, and replays earlier lines.
    const lines =
      turn % 13 === 5 ? [opener, call, thinking, ...rest] : [opener, thinking, call, ...rest];
    if (turn % 17 === 9) lines.push(thinking);
    previous = id("0006");
    yield lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  }
}

const heapMib = () => {
  if (typeof globalThis.gc === "function") globalThis.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
};

const measure = Effect.fn("checkClaudeTranscripts.measure")(function* (
  options: Options,
  mib: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-transcript-measure-" });
  const filePath = NodePath.join(scratch, "synthetic.jsonl");
  const target = mib * 1024 * 1024;
  const descriptor = NodeFS.openSync(filePath, "w");
  let fileBytes = 0;
  const turns = syntheticTurns(options.payloadBytes);
  while (fileBytes < target) {
    const chunk = turns.next().value;
    if (chunk === undefined) break;
    const encoded = encoder.encode(chunk);
    NodeFS.writeSync(descriptor, encoded);
    fileBytes += encoded.length;
  }
  NodeFS.closeSync(descriptor);

  const before = heapMib();
  const index = new ClaudeTranscriptIndex();
  const synced = yield* syncClaudeTranscriptIndex({ filePath, index });
  const afterIndex = heapMib();
  const structure = claudeTranscriptStructure(index);
  const items = structure.turns.reduce((sum, turn) => sum + turn.lineUuids.length, 0);
  const afterStructure = heapMib();
  const last = structure.turns.at(-1);
  const content =
    last === undefined
      ? undefined
      : yield* readClaudeTranscriptTurn({ filePath, index, idScope: "measure", turn: last });
  const appended = turns.next().value ?? "";
  NodeFS.appendFileSync(filePath, appended);
  const resync = yield* syncClaudeTranscriptIndex({ filePath, index });
  const footprint = index.footprint();
  const heldIndex = afterIndex - before;
  return {
    fileBytes,
    linesRead: synced.linesRead,
    entries: index.entryCount,
    repeatedLines: index.repeatedLines,
    indexHeapMib: Number(heldIndex.toFixed(1)),
    indexHeapBytesPerLine: Math.round((heldIndex * 1024 * 1024) / synced.linesRead),
    indexColumnBytes: footprint.columnBytes,
    indexStringCharacters: footprint.stringCharacters,
    structureHeapMib: Number((afterStructure - afterIndex).toFixed(1)),
    turns: structure.turns.length,
    itemLines: items,
    lastTurnItems: content?.items.length,
    appendedBytes: encoder.encode(appended).length,
    resyncBytesRead: resync.bytesRead,
    resyncRebuilt: resync.rebuilt,
    gcExposed: typeof globalThis.gc === "function",
  };
}, Effect.scoped);

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    yield* Console.log(USAGE);
    return;
  }
  const options = yield* parseOptions(argv);
  if (options.syntheticMib !== undefined) {
    yield* Console.log(yield* encodeReport(yield* measure(options, options.syntheticMib)));
    return;
  }
  const pick = random(options.seed);
  const all = transcriptsUnder(options.root).filter(
    (path) => NodeFS.statSync(path).size <= options.maxFileBytes,
  );
  const chosen = Number.isFinite(options.files)
    ? all
        .map((path) => ({ path, key: pick(1 << 30) }))
        .toSorted((a, b) => a.key - b.key)
        .slice(0, options.files)
        .map(({ path }) => path)
    : all;
  if (chosen.length === 0) {
    return yield* new UsageError({
      reason: `No transcripts under the root, so nothing was checked.`,
    });
  }
  const totals: Record<string, number> = {};
  const examples = new Map<string, Array<ClaudeTranscriptViolation & { readonly file: number }>>();
  for (const [index, path] of chosen.entries()) {
    const result = yield* checkFile(path, options, options.seed + index);
    for (const [key, value] of Object.entries(result.counts)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
    for (const violation of result.violations) {
      const list = examples.get(violation.kind) ?? [];
      if (list.length < 5) list.push({ ...violation, file: index });
      examples.set(violation.kind, list);
    }
  }
  totals.files = chosen.length;
  // Files are named by their index in this run, not their path, which names a project.
  yield* Console.log(yield* encodeReport({ totals, examples: Object.fromEntries(examples) }));
  if (examples.size > 0) return yield* Effect.die("The transcript parser broke an invariant.");
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
