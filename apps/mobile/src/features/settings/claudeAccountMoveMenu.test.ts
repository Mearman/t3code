import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import { claudeMoveMenuAction, claudeMoveMenuTarget } from "./claudeAccountMoveMenu";

const account = (instanceId: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: `${instanceId} name`,
  installed: true,
  enabled: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
const source = ProviderInstanceId.make("claudeAgent");
const item = { title: "Move" };
const idOf = (action: MenuAction | undefined) => {
  if (action?.id === undefined) throw new Error("menu item without an id");
  return action.id;
};

describe("claudeMoveMenuAction", () => {
  it("offers every other account, however many there are", () => {
    const providers = ["claudeAgent", "a", "b", "c", "d", "e"].map(account);
    const action = claudeMoveMenuAction(providers, source, item, false);
    expect(action?.subactions?.map((entry) => entry.title)).toEqual([
      "a name",
      "b name",
      "c name",
      "d name",
      "e name",
    ]);
    for (const entry of action?.subactions ?? [])
      expect(claudeMoveMenuTarget(providers, source, idOf(entry), false)?.displayName).toBe(
        entry.title,
      );
  });

  it("names the one other account directly, and nothing when there is none", () => {
    const providers = [account("claudeAgent"), account("work")];
    const action = claudeMoveMenuAction(providers, source, item, false);
    expect(action?.subactions).toBeUndefined();
    expect(claudeMoveMenuTarget(providers, source, idOf(action), false)?.instanceId).toBe("work");
    expect(claudeMoveMenuAction([account("claudeAgent")], source, item, false)).toBeUndefined();
  });

  it("ignores other menu ids and reports an account that has gone", () => {
    const providers = [account("claudeAgent"), account("work")];
    expect(claudeMoveMenuTarget(providers, source, "copy-thread", false)).toBeUndefined();
    expect(claudeMoveMenuTarget(providers, source, "claude-move-to:gone", false)).toBeNull();
  });
});
