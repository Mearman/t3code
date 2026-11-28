import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canManage: true,
  move: vi.fn(),
  alert: vi.fn(),
}));

const account = (instanceId: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: instanceId,
  installed: true,
  enabled: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-28T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canManage }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { moveClaudeThreads: "move", listClaudeThreadsToMove: "list" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.move }));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { claudeAccountMoves: true } },
    providers: [account("personal"), account("work")],
    settings: { claudeSessionSync: { compactBeforeAccountMove: false } },
  }),
}));

import { useClaudeAccountMove } from "./useClaudeAccountMove";

const source = ProviderInstanceId.make("personal");
const thread = ThreadId.make("thread");

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let hook: ReturnType<typeof useClaudeAccountMove> | undefined;
  function Probe() {
    hook = useClaudeAccountMove(EnvironmentId.make("env"));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    hook: () => hook!,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("offers no move without permission to manage providers", () => {
  state.canManage = false;
  using mounted = mount();
  expect(mounted.hook().menuAction(source, { title: "Move" })).toBeUndefined();
  state.canManage = true;
});

it("shows why a move failed instead of asking to reconnect", async () => {
  state.alert.mockReset();
  state.move.mockReset();
  state.move.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("You need permission to manage providers."))),
  );
  using mounted = mount();
  const action = mounted.hook().menuAction(source, { title: "Move" });
  expect(action?.id).toBeDefined();
  act(() => {
    mounted.hook().handleMenuAction(action!.id!, source, thread);
  });
  const [, , buttons] = state.alert.mock.calls[0] as [
    string,
    string,
    ReadonlyArray<{ readonly text: string; readonly onPress?: () => void }>,
  ];
  await act(async () =>
    buttons.find((button) => button.text === "Move without compacting")?.onPress?.(),
  );
  expect(state.alert.mock.calls[1]).toEqual([
    "Could not move",
    "You need permission to manage providers.",
  ]);
});
