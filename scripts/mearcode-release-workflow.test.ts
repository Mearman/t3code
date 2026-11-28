// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

const workflow = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../.github/workflows/mearcode-release.yml"),
  "utf8",
);

it("builds the bundle with the fork's Issues enabled, so the boot error offers its report link", () => {
  const step = /- name: Build JS bundle\n(?<body>(?: {8}.*\n)+)/.exec(workflow)?.groups?.body;
  expect(step).toBeDefined();
  expect(step).toContain('T3CODE_ISSUES_ENABLED: "1"');
});
