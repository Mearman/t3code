#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone repository check.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Built from parts so this file never contains the names it forbids.
const LEGACY_WORD = ["exa", "code"].join("");
const LEGACY_ID = ["io", "exadev"].join("\\.");
const LEGACY_PATTERN = new RegExp(`${LEGACY_WORD}|exa[-_]code|${LEGACY_ID}`, "i");

/** The product's current bundle and application id, which the release workflows must carry. */
export const APP_ID = "uk.mearman.mearcode";

// A line that keeps the old name because the thing it names is provisioned outside the repository:
// the alias of the key inside the release keystore held in repository secrets, and the subject of
// the Android signing certificate, which only a new certificate can change.
const ALLOWED_LINES: ReadonlyArray<RegExp> = [
  new RegExp(`--ks-key-alias ${LEGACY_WORD}\\b`),
  new RegExp(`CN=${LEGACY_WORD} Android`, "i"),
  new RegExp(`under the alias \`${LEGACY_WORD}\``),
];

// Workflows that must set the bundle id, so renaming it back is also caught.
export const APP_ID_FILES: ReadonlyArray<string> = [
  ".github/workflows/mearcode-release.yml",
  ".github/workflows/mearcode-android.yml",
];

export interface LegacyNameFinding {
  readonly file: string;
  readonly line: number | null;
  readonly text: string;
}

/**
 * Every shipped path or line in `files` (repository-relative path to contents, or `null` for a
 * binary file) that still carries the legacy product name or bundle id, outside `ALLOWED_LINES`,
 * plus each `APP_ID_FILES` entry that does not carry the current id.
 */
export function findLegacyNames(
  files: ReadonlyMap<string, string | null>,
): ReadonlyArray<LegacyNameFinding> {
  const findings: Array<LegacyNameFinding> = [];
  for (const [file, contents] of files) {
    if (LEGACY_PATTERN.test(file)) findings.push({ file, line: null, text: "path" });
    contents?.split("\n").forEach((text, index) => {
      if (LEGACY_PATTERN.test(text) && !ALLOWED_LINES.some((allowed) => allowed.test(text))) {
        findings.push({ file, line: index + 1, text: text.trim().slice(0, 120) });
      }
    });
  }
  for (const file of APP_ID_FILES) {
    if (!files.get(file)?.includes(APP_ID)) {
      findings.push({ file, line: null, text: `does not set ${APP_ID}` });
    }
  }
  return findings;
}

function readTrackedFiles(root: string): Map<string, string | null> {
  const listed = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 1 << 28,
  });
  const files = new Map<string, string | null>();
  for (const file of listed.toString("utf8").split("\0").filter(Boolean)) {
    const absolute = NodePath.join(root, file);
    if (!NodeFS.statSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = NodeFS.readFileSync(absolute);
    files.set(file, bytes.includes(0) ? null : bytes.toString("utf8"));
  }
  return files;
}

if (import.meta.main) {
  const findings = findLegacyNames(readTrackedFiles(NodePath.resolve(import.meta.dirname, "..")));
  for (const { file, line, text } of findings) {
    console.error(`${file}${line === null ? "" : `:${line}`}: ${text}`);
  }
  if (findings.length > 0) {
    console.error(`${findings.length} legacy product name finding(s).`);
    process.exit(1);
  }
}
