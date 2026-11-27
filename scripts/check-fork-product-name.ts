#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone release check.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UPSTREAM_PRODUCT_NAME, UPSTREAM_PRODUCT_PATTERN } from "@t3tools/shared/productName";

const SHIPPED_TEXT = /\.(?:js|mjs|cjs|html|json|webmanifest)$/;
// Licence texts quote their upstream packages, not this product.
const IGNORED_FILES = /third-party-licenses/;
const CONTEXT = 40;

// Upstream's repository and sites, which a fork build names nowhere except where it must:
// a quoted literal in this list is an address the code shares with upstream by design.
const UPSTREAM_ADDRESS = /t3\.codes|pingdotgg\/t3code/g; // product-name: keep
const SHARED_ADDRESSES: ReadonlySet<string> = new Set([
  // How the code tells upstream's repository from a fork's.
  "pingdotgg/t3code", // product-name: keep
  // Upstream-only branches: its site, installer and download page, and the editor schema URL.
  "https://t3.codes/install.sh",
  "https://t3.codes/install.ps1",
  "https://t3.codes/download",
  "https://t3.codes/mobile",
  "https://t3.codes/privacy-policy",
  "https://t3.codes/schema/t3.json",
  "noreply@t3.codes",
  // The telemetry collector, until a fork build has none by default.
  "https://ingest.t3.codes",
]);
// T3's hosted web app is a connection surface any server can use, so its hostnames stay.
const HOSTED_APP = /(?:https?:\/\/)?(?:[\w-]+\.)*app\.t3\.codes/g;
const QUOTED_TOKEN = /(["'`])([^"'`\s]*(?:t3\.codes|pingdotgg\/t3code)[^"'`\s]*)\1/g; // product-name: keep

export interface UpstreamNameFinding {
  readonly file: string;
  readonly context: string;
}

const QUOTED_UPSTREAM_NAME = new RegExp(`(["'\`])${UPSTREAM_PRODUCT_NAME}\\1`);

/**
 * `text` without the upstream addresses a fork build is allowed to carry: the quoted shared
 * addresses, T3's hosted app, and the one quoted literal of upstream's name that tells an
 * upstream build from a fork's (`UPSTREAM_PRODUCT_NAME`; a bundle holds it once).
 */
export function withoutSharedAddresses(text: string): string {
  return text
    .replace(HOSTED_APP, "")
    .replace(QUOTED_TOKEN, (token, _quote, address: string) =>
      SHARED_ADDRESSES.has(address) ? "" : token,
    )
    .replace(QUOTED_UPSTREAM_NAME, "");
}

/**
 * Every place under `directories` where built, shipped text still names upstream's product, or
 * its repository or site outside the allowed addresses.
 */
export function findUpstreamNames(
  directories: ReadonlyArray<string>,
): ReadonlyArray<UpstreamNameFinding> {
  const findings: Array<UpstreamNameFinding> = [];
  const visit = (path: string) => {
    for (const entry of NodeFS.readdirSync(path, { withFileTypes: true })) {
      const child = NodePath.join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (SHIPPED_TEXT.test(entry.name) && !IGNORED_FILES.test(entry.name)) {
        const text = withoutSharedAddresses(NodeFS.readFileSync(child, "utf8"));
        for (const pattern of [UPSTREAM_PRODUCT_PATTERN, UPSTREAM_ADDRESS]) {
          for (const match of text.matchAll(pattern)) {
            findings.push({
              file: child,
              context: text
                .slice(Math.max(0, match.index - CONTEXT), match.index + match[0].length + CONTEXT)
                .replaceAll("\n", " "),
            });
          }
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
    console.error(`${findings.length} place(s) still name upstream in the fork build.`);
    process.exit(1);
  }
}
