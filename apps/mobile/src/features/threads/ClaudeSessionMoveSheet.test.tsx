import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

const state = vi.hoisted(() => ({
  targets: [] as Array<{ environmentId: string; label: string }>,
  canMove: true,
  moves: [] as Array<unknown>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  View: ({ children }: Children) => <div>{children}</div>,
  Switch: (props: { accessibilityLabel: string; onValueChange: (value: boolean) => void }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn() }),
  usePreventRemove: () => undefined,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.canMove }));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: Children) => <span>{children}</span>,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: vi.fn() }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../state/claudeReplication", () => ({
  claudeReplicationEnvironment: {
    moveTargets: () => "targets",
    move: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { targets: state.targets }, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    state.moves.push(input);
    return {
      _tag: "Success",
      value: {
        targetEnvironmentId: "environment-two",
        sessionId: SESSION,
        cwd: "/work",
        worktreePath: "/work/moved",
        branch: "main-moved",
        resumeCommand: `cd /work && claude --resume ${SESSION}`,
        codeBytes: 0,
        warnings: [],
      },
    };
  },
}));

import { ClaudeSessionMoveSheet } from "./ClaudeSessionMoveSheet";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const here = EnvironmentId.make("environment-here");

function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const route = {
    key: "move",
    name: "ClaudeSessionMove",
    params: { environmentId: here, threadId: ThreadId.make(`claude:${SESSION}`) },
  } as const;
  act(() => root.render(<ClaudeSessionMoveSheet route={route} />));
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent === label);
  return { host, button, unmount: () => act(() => root.unmount()) };
}

it("moves to the machine chosen among those that take moves, with take over, and shows how to resume", async () => {
  state.targets = [
    { environmentId: "environment-one", label: "One" },
    { environmentId: "environment-two", label: "Two" },
  ];
  state.moves = [];
  const { host, button, unmount } = render();

  act(() => button("Two")?.click());
  act(() => host.querySelector<HTMLInputElement>("input[type=checkbox]")?.click());
  await act(async () => button("Move")?.click());

  expect(state.moves).toEqual([
    {
      environmentId: here,
      input: { sessionId: SESSION, targetEnvironmentId: "environment-two", takeOver: true },
    },
  ]);
  expect(host.textContent).toContain(`claude --resume ${SESSION}`);
  unmount();
});

it("says why nothing is listed and cannot move with no machine that takes moves", () => {
  state.targets = [];
  const { host, button, unmount } = render();
  expect(host.textContent).toContain("No linked machine can take this session.");
  expect(button("Move")?.disabled).toBe(true);
  unmount();
});

it("cannot move without permission to run threads there", () => {
  state.targets = [{ environmentId: "environment-one", label: "One" }];
  state.canMove = false;
  const { button, unmount } = render();
  expect(button("Move")?.disabled).toBe(true);
  state.canMove = true;
  unmount();
});
