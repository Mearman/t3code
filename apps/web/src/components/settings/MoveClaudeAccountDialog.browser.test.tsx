import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

// The dialog is portalled and animates in, so its button is pressed through the DOM.
const press = (label: string) =>
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );

const state = vi.hoisted(() => ({
  move: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  toast: vi.fn(),
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

vi.mock("./claudeMoveDialogState", () => ({ claudeMoveDialogAtom: "dialog" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "dialog"
      ? { environmentId: "env", sourceInstanceId: "personal" }
      : [account("personal"), account("work")],
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => "providers",
    moveClaudeThreads: "move",
    listClaudeThreadsToMove: "list",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "move" ? state.move : state.list),
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => false }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { set: state.close } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

import { MoveClaudeAccountDialogHost } from "./MoveClaudeAccountDialog";

it("moves a whole account one thread at a time, showing progress, and stays open meanwhile", async () => {
  const threads = [ThreadId.make("one"), ThreadId.make("two")];
  let finishSecond: (value: unknown) => void = () => {};
  state.list.mockResolvedValueOnce(AsyncResult.success({ threadIds: threads }));
  state.move
    .mockResolvedValueOnce(
      AsyncResult.success({ outcomes: [{ threadId: threads[0], status: "moved" }] }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
  await using screen = await render(<MoveClaudeAccountDialogHost />);
  await press("Move to work");
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Moved 1 of 2 threads. Keep this open to see what moved.");
  expect(state.move.mock.calls.map(([call]) => call.input.threadIds)).toEqual([
    [threads[0]],
    [threads[1]],
  ]);
  expect(state.move.mock.calls[0]?.[0]).toEqual({
    environmentId: EnvironmentId.make("env"),
    input: { threadIds: [threads[0]], targetInstanceId: "work", compact: false },
  });

  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(state.close).not.toHaveBeenCalled();

  finishSecond(AsyncResult.success({ outcomes: [{ threadId: threads[1], status: "moved" }] }));
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  expect(state.close).toHaveBeenCalledWith("dialog", null);
  expect(state.toast).toHaveBeenCalledWith({ type: "success", title: "Moved 2 threads to work" });
});
