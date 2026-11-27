import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planClaudeAccountSave, providerAccountRows } from "./claude-accounts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");

describe("planClaudeAccountSave", () => {
  it("adds a signed-in config folder as a new Claude instance with a free id", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: { driver: claude, config: { homePath: "~/.claude-work" } },
    };
    const plan = (name: string, configDir: string) =>
      planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: null,
        draft: { name, configDir },
      });

    expect(plan(" Work ", " ~/.claude-willy ")).toEqual({
      mutation: {
        operation: "create",
        instanceId: "claudeAgent_work_2",
        instance: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Work",
          config: { homePath: "~/.claude-willy" },
        },
      },
    });
    expect(plan("", "~/.claude-willy")).toHaveProperty("error");
    expect(plan("Willy", " ")).toHaveProperty("error");
  });

  it("edits the name and folder without dropping the instance's other settings", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: {
        driver: claude,
        displayName: "Work",
        accentColor: "#ff0000",
        enabled: false,
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
        config: { homePath: "~/.claude-work", binaryPath: "/opt/claude", launchArgs: "--chrome" },
      },
    };
    const edit = (name: string, configDir: string) =>
      planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: work,
        draft: { name, configDir },
      });

    expect(edit("Willy", "~/.claude-willy")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          ...providerInstances[work],
          displayName: "Willy",
          config: {
            binaryPath: "/opt/claude",
            launchArgs: "--chrome",
            homePath: "~/.claude-willy",
          },
        },
      },
    });
    // Clearing both falls back to the driver's label and the default ~/.claude folder.
    expect(edit("", "")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          driver: claude,
          accentColor: "#ff0000",
          enabled: false,
          environment: providerInstances[work]!.environment,
          config: { binaryPath: "/opt/claude", launchArgs: "--chrome" },
        },
      },
    });
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude, config: { homePath: "~/.claude-work" } } },
        policy: undefined,
        instanceId: work,
        draft: { name: "", configDir: "" },
      }),
    ).toEqual({
      mutation: { operation: "upsert", instanceId: work, instance: { driver: claude } },
    });
  });

  it("refuses instances the managed policy pins", () => {
    const policy: ManagedPolicySummary = {
      organization: "Example Corp",
      lockedSettings: ["providerInstances.claudeAgent_work.config.homePath"],
    };
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude } },
        policy,
        instanceId: work,
        draft: { name: "Work", configDir: "~/.claude-other" },
      }),
    ).toEqual({ error: "Managed by Example Corp." });
  });
});

describe("providerAccountRows", () => {
  const provider = (driver: string, canAuthenticate: boolean): ServerProvider => ({
    instanceId: ProviderInstanceId.make(`${driver}_test`),
    driver: ProviderDriverKind.make(driver),
    installed: true,
    enabled: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate, canInstall: false },
  });

  it("keeps a Claude account's name and folder editable once it signs in from the app", () => {
    const rows = providerAccountRows([
      provider("claudeAgent", true),
      provider("claudeAgent", false),
      provider("codex", true),
      provider("cursor", false),
    ]);
    expect(
      rows.map(({ provider: { driver }, signIn, claudeFolder }) => [driver, signIn, claudeFolder]),
    ).toEqual([
      ["claudeAgent", true, true],
      ["claudeAgent", false, true],
      ["codex", true, false],
    ]);
  });
});
