import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";

import { contextInput } from "./triagePromptFixtures.ts";

const loadBuild = async (defines: Record<string, string>) => {
  vi.resetModules();
  for (const [name, value] of Object.entries(defines)) vi.stubGlobal(name, value);
  return import("./triagePrompt.ts");
};

const forkDefines = {
  __T3CODE_DESKTOP_PRODUCT_NAME__: "ExaCode",
  __T3CODE_RELEASE_REPOSITORY__: "owner/fork",
};

const failedClone = {
  _tag: "failed",
  serverVersion: "0.1.1",
  reason: "no network",
} as const;

const cli = { kind: "cli", cliVersion: "0.0.42", launchedAs: "npx t3 triage" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("gives a fork build's session the fork's playbook, never upstream's", async () => {
  const { buildTriageSeedPrompt } = await loadBuild(forkDefines);
  const prompt = buildTriageSeedPrompt({ contextFilePath: "/x/context.md", entry: cli });
  assert.notInclude(prompt, "newer playbook");
  assert.notInclude(prompt, "pingdotgg");
  assert.include(prompt, "repos/owner/fork --jq .has_issues");
});

it("points a fork build's step references at the renumbered clone step", async () => {
  const { buildTriageContext } = await loadBuild(forkDefines);
  const context = buildTriageContext({ ...contextInput, entry: cli, server: "stopped", sourceClone: failedClone });
  assert.include(context, "Clone it as step 3 describes.");
  assert.notInclude(context, "step 4");
  assert.include(context, "- Repo: https://github.com/owner/fork");
});

it("keeps an unbranded build on upstream's playbook and repository, whatever repository built it", async () => {
  const { buildTriageContext, buildTriageSeedPrompt } = await loadBuild({
    __T3CODE_RELEASE_REPOSITORY__: "owner/fork",
  });
  const context = buildTriageContext({ ...contextInput, entry: cli, server: "stopped", sourceClone: failedClone });
  assert.include(context, "- Repo: https://github.com/pingdotgg/t3code");
  assert.include(context, "Clone it as step 4 describes.");
  const prompt = buildTriageSeedPrompt({ contextFilePath: "/x/context.md", entry: cli });
  assert.include(prompt, "Check for a newer playbook");
});
