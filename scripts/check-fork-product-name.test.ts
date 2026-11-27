// @effect-diagnostics nodeBuiltinImport:off - Writes a temporary built directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { findUpstreamNames } from "./check-fork-product-name.ts";

const found = (files: Record<string, string>) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-name-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, name), text);
    }
    return findUpstreamNames([directory])
      .map((finding) => NodePath.relative(directory, finding.file))
      .toSorted();
  } finally {
    NodeFS.rmSync(directory, { recursive: true });
  }
};

it("finds upstream's name in shipped text and ignores maps, licences and T3's GitHub App", () => {
  expect(
    found({
      "assets/app.js": 'const a="Enjoying T3 Code?";',
      "assets/app.js.map": '{"sourcesContent":["T3 Code"]}',
      "index.html": "<title>T3-Code</title>",
      "third-party-licenses.json": '{"x":"T3 Code"}',
      "assets/github.js": 'const a="Install T3 Code for GitHub";',
      "assets/clean.js": 'const a="Enjoying ExaCode?";',
    }),
  ).toEqual(["assets/app.js", "index.html"]);
});

it("allows the one quoted literal that identifies upstream once per build, not per file", () => {
  expect(found({ "a.js": 'const u="T3 Code";' })).toEqual([]);
  expect(found({ "a.js": 'const u="T3 Code";const v="T3 Code";' })).toEqual(["a.js"]);
  expect(found({ "a.js": 'const u="T3 Code";', "b.js": 'const t="T3 Code";' })).toHaveLength(1);
});

it("does not take a look-alike host for T3's hosted app, and also scans css, svg and text", () => {
  expect(found({ "a.js": 'const h="https://evilapp.t3.codes/x";' })).toEqual(["a.js"]);
  expect(found({ "a.js": 'const h="https://app.t3.codes/x";' })).toEqual([]);
  expect(
    found({
      "a.css": "/* T3 Code */",
      "a.svg": "<title>T3 Code</title>",
      "a.txt": "see https://github.com/pingdotgg/t3code",
    }),
  ).toEqual(["a.css", "a.svg", "a.txt"]);
});

it("finds upstream's repository and site outside the allowed quoted addresses", () => {
  expect(
    found({
      // Stray: prompt text, an API path, a link, a prose mention, a path that is not shared.
      "stray-prompt.js": "const p=`Search issues in pingdotgg/t3code (use gh)`;",
      "stray-api.js": "const p=`repos/pingdotgg/t3code --jq .node_id`;",
      "stray-link.js": 'const p="https://github.com/pingdotgg/t3code/issues/new";',
      "stray-site.js": 'const p="See https://t3.codes for documentation.";',
      "stray-path.js": 'const p="https://t3.codes/docs/anything";',
      // Allowed: the repository constant, upstream-only addresses and T3's hosted app.
      "ok-constant.js": 'const r="pingdotgg/t3code";',
      "ok-schema.js": 'const s="https://t3.codes/schema/t3.json";',
      "ok-download.js": "const s=`https://t3.codes/download`;",
      "ok-hosted.js": 'const s="Remote: https://nightly.app.t3.codes/thread";',
    }),
  ).toEqual(["stray-api.js", "stray-link.js", "stray-path.js", "stray-prompt.js", "stray-site.js"]);
});
