// @effect-diagnostics nodeBuiltinImport:off - a maintenance script that walks a transcript tree.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  checkClaudeTranscriptEvents,
  type ClaudeTranscriptViolation,
} from "../src/claudeSessions/ClaudeTranscriptInvariants.ts";
import {
  claudeTranscriptSessionId,
  initialClaudeTranscriptCursor,
  readClaudeTranscript,
  type ClaudeTranscriptCursor,
} from "../src/claudeSessions/ClaudeTranscriptReader.ts";
import type { ClaudeTranscriptEvent } from "../src/claudeSessions/ClaudeTranscriptSegments.ts";

const USAGE = `Checks the Claude transcript parser against real transcripts, printing counts and line shapes only.

  node apps/server/scripts/check-claude-transcripts.ts [root] [--files N] [--splits N] [--seed N] [--max-bytes N]

root defaults to ~/.claude/projects. Exits 1 when any invariant is broken.`;

interface Options {
  readonly root: string;
  readonly files: number;
  readonly splits: number;
  readonly seed: number;
  readonly maxFileBytes: number;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  const value = (name: string, fallback: number) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : Number(argv[index + 1]);
  };
  const root = argv.find(
    (arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"),
  );
  return {
    root: root ?? NodePath.join(NodeOS.homedir(), ".claude", "projects"),
    files: value("--files", Number.POSITIVE_INFINITY),
    splits: value("--splits", 6),
    seed: value("--seed", 1),
    maxFileBytes: value("--max-bytes", 256 * 1024 * 1024),
  };
}

// A small deterministic generator, so a failing split can be reproduced from its seed.
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

const BUDGET = Number.MAX_SAFE_INTEGER;

// Reads `filePath` to its end in reads of at most `maxBytes`, as the consumer would.
const readAll = (
  filePath: string,
  known: Set<string>,
  cursor: ClaudeTranscriptCursor,
  maxBytes: () => number,
) =>
  Effect.gen(function* () {
    const events: Array<ClaudeTranscriptEvent> = [];
    const malformedOffsets: Array<number> = [];
    let next = cursor;
    for (;;) {
      const read = yield* readClaudeTranscript({
        filePath,
        sessionId: "check",
        cursor: next,
        maxBytes: maxBytes(),
        knownUuids: (uuids) => Effect.succeed(new Set(uuids.filter((uuid) => known.has(uuid)))),
      });
      if (read.rewritten) return yield* Effect.die(`A transcript changed while it was checked.`);
      events.push(...read.events);
      malformedOffsets.push(...read.malformed.map((line) => line.offset));
      for (const uuid of read.consumedUuids) known.add(uuid);
      next = read.cursor;
      if (read.atEnd) return { events, malformedOffsets, cursor: next };
    }
  });

const checkFile = (filePath: string, options: Options, scratch: string, seed: number) =>
  Effect.gen(function* () {
    const bytes = NodeFS.readFileSync(filePath);
    const complete = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
    const lines = complete.toString("utf8").split("\n").slice(0, -1);
    const lineStarts: Array<number> = [];
    for (let at = 0; at < complete.length; at = complete.indexOf(0x0a, at) + 1) lineStarts.push(at);

    const whole = yield* readAll(filePath, new Set(), initialClaudeTranscriptCursor, () => BUDGET);
    const malformedLines = new Set(
      whole.malformedOffsets.map((offset) => lineStarts.indexOf(offset) + 1),
    );

    // The same bytes again, written in random pieces that can end mid-line, each read with a random byte budget, carrying the consumer's known uuids between reads.
    const next = random(seed);
    const growing = NodePath.join(scratch, "transcript.jsonl");
    NodeFS.writeFileSync(growing, "");
    const cuts = Array.from({ length: options.splits - 1 }, () => next(complete.length)).toSorted(
      (left, right) => left - right,
    );
    const known = new Set<string>();
    const split: Array<ClaudeTranscriptEvent> = [];
    let cursor = initialClaudeTranscriptCursor;
    let written = 0;
    for (const cut of [...cuts, complete.length]) {
      NodeFS.appendFileSync(growing, complete.subarray(written, cut));
      written = cut;
      const part = yield* readAll(growing, known, cursor, () => 1 + next(64 * 1024));
      split.push(...part.events);
      cursor = part.cursor;
    }
    return checkClaudeTranscriptEvents({
      lines,
      whole: whole.events,
      split,
      malformedLines,
    });
  });

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions(argv);
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
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-transcript-check-"));
  const totals: Record<string, number> = {};
  const examples = new Map<string, Array<ClaudeTranscriptViolation & { readonly file: number }>>();
  try {
    for (const [index, path] of chosen.entries()) {
      const result = yield* checkFile(path, options, scratch, options.seed + index);
      for (const [key, value] of Object.entries(result.counts))
        totals[key] = (totals[key] ?? 0) + value;
      for (const violation of result.violations) {
        const list = examples.get(violation.kind) ?? [];
        if (list.length < 5) list.push({ ...violation, file: index });
        examples.set(violation.kind, list);
      }
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  totals.files = chosen.length;
  // Files are named by their index in this run, not their path, which names a project.
  console.log(JSON.stringify({ totals, examples: Object.fromEntries(examples) }, null, 1));
  if (examples.size > 0) process.exitCode = 1;
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
