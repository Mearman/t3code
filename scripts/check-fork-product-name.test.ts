// @effect-diagnostics nodeBuiltinImport:off - Writes a temporary built directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { findUpstreamNames } from "./check-fork-product-name.ts";

const withDirectory = (files: Record<string, string>, run: (directory: string) => void) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-name-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, name), text);
    }
    run(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true });
  }
};

it("finds upstream's name in shipped text and ignores maps, licences and T3's GitHub App", () => {
  withDirectory(
    {
      "assets/app.js": 'const a="Enjoying T3 Code?";',
      "assets/app.js.map": '{"sourcesContent":["T3 Code"]}',
      "index.html": "<title>T3-Code</title>",
      "third-party-licenses.json": '{"x":"T3 Code"}',
      "assets/github.js": 'const a="Install T3 Code for GitHub";',
      "assets/clean.js": 'const a="Enjoying ExaCode?";',
    },
    (directory) => {
      const found = findUpstreamNames([directory]).map((finding) =>
        NodePath.relative(directory, finding.file),
      );
      expect(found.toSorted()).toEqual(["assets/app.js", "index.html"]);
    },
  );
});
