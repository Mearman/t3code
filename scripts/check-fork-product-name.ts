#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A standalone release check over built files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const SHIPPED_TEXT = /\.(?:js|mjs|cjs|html|json|webmanifest)$/;
// T3's own GitHub App keeps its real name wherever it is shown.
const UPSTREAM_NAME = /T3[ -]Code(?! for GitHub)/g; // product-name: keep
// Licence texts quote their upstream packages, not this product.
const IGNORED_FILES = /third-party-licenses/;
const CONTEXT = 40;

export interface UpstreamNameFinding {
  readonly file: string;
  readonly context: string;
}

/** Every place under `directories` where built, shipped text still names upstream's product. */
export function findUpstreamNames(
  directories: ReadonlyArray<string>,
): ReadonlyArray<UpstreamNameFinding> {
  const findings: Array<UpstreamNameFinding> = [];
  const visit = (path: string) => {
    for (const entry of NodeFS.readdirSync(path, { withFileTypes: true })) {
      const child = NodePath.join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (SHIPPED_TEXT.test(entry.name) && !IGNORED_FILES.test(entry.name)) {
        const text = NodeFS.readFileSync(child, "utf8");
        for (const match of text.matchAll(UPSTREAM_NAME)) {
          findings.push({
            file: child,
            context: text
              .slice(Math.max(0, match.index - CONTEXT), match.index + match[0].length + CONTEXT)
              .replaceAll("\n", " "),
          });
        }
      }
    }
  };
  for (const directory of directories) visit(directory);
  return findings;
}

if (import.meta.main) {
  const findings = findUpstreamNames(process.argv.slice(2));
  for (const finding of findings.slice(0, 40)) {
    console.error(`${finding.file}: ...${finding.context}...`);
  }
  if (findings.length > 0) {
    console.error(`${findings.length} place(s) still name upstream's product in the fork build.`);
    process.exit(1);
  }
}
