// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  playbookFor,
  TRIAGE_PLAYBOOK,
} from "./triagePrompt.ts";
import { contextInput } from "./triagePromptFixtures.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Older releases fetch the repository playbook.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // Windows .cmd shims cannot carry multiline argv.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file labels the CLI version as the CLI's, not the user's build", () => {
  const context = buildTriageContext({
    ...contextInput,
    entry: { kind: "cli", cliVersion: "0.0.42", launchedAs: "npx t3 triage" },
    server: "running (pid 42, http://127.0.0.1:3773, version 0.0.43-nightly.20260923.2173)",
  });
  assert.notInclude(context, "Installed version");
  assert.notInclude(context, "Release tag");
  assert.include(context, "- Triage CLI version: 0.0.42 (");
  assert.include(context, "version 0.0.43-nightly.20260923.2173");
  assert.notInclude(context, "runs inside T3 Code");
});

it("in-app context warns the agent off its own server and points at the clone in progress", () => {
  const context = buildTriageContext({
    ...contextInput,
    entry: { kind: "app", client: "T3 Code Desktop version 0.1.1 on macos" },
    server: "running (pid 42, version 0.1.1); this session runs inside it",
    sourceClone: {
      _tag: "cloning",
      directory: "/home/u/.t3/source/abc123",
      ref: "v0.1.1",
      commit: "abc123",
      serverVersion: "0.1.1",
    },
  });
  assert.notInclude(context, "Triage CLI version");
  assert.include(context, "- Started from: T3 Code Desktop version 0.1.1 on macos (");
  assert.include(context, "## This session runs inside T3 Code");
  assert.include(context, "/home/u/.t3/source/abc123  (v0.1.1, commit abc123)");
  assert.include(context, "Wait for it instead of\ncloning again.");
});

const fork = { fork: true, repository: "owner/fork", label: "via-triage" };

it("leaves upstream's playbook untouched", () => {
  assert.equal(
    playbookFor(TRIAGE_PLAYBOOK, {
      fork: false,
      repository: "pingdotgg/t3code",
      label: "via-triage",
    }),
    TRIAGE_PLAYBOOK,
  );
});

it("gives a fork's session no upstream playbook, search target or filing target", () => {
  const playbook = playbookFor(TRIAGE_PLAYBOOK, fork);
  assert.notInclude(playbook, "Check for a newer playbook");
  assert.notInclude(playbook, "PLAYBOOK.md");
  assert.notInclude(playbook, "newer playbook");
  assert.notInclude(playbook, "pingdotgg");
  assert.include(playbook, "https://github.com/owner/fork <source-cache-dir>/<hash>");
  assert.include(playbook, "repos/owner/fork --jq .node_id");
});

it("renumbers a fork's steps and the references to them", () => {
  const playbook = playbookFor(TRIAGE_PLAYBOOK, fork);
  assert.deepEqual(
    [...playbook.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.include(playbook, "## 3. Get the source");
  assert.include(playbook, "from step 3, or say it is");
});

it("stops a fork's session when the fork has Issues off, instead of filing elsewhere", () => {
  const playbook = playbookFor(TRIAGE_PLAYBOOK, fork);
  assert.include(playbook, "gh api repos/owner/fork --jq .has_issues");
  assert.include(playbook, "do not file it anywhere else");
});

it("uses a fork's own triage label", () => {
  const playbook = playbookFor(TRIAGE_PLAYBOOK, { ...fork, label: "reported-in-app" });
  assert.notInclude(playbook, "via-triage");
  assert.include(playbook, "Label it `reported-in-app`");
});
