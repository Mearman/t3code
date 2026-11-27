import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };
type ButtonProps = { label: string; disabled?: boolean; onPress: () => void };

const forkFromRun = vi.hoisted(() =>
  vi.fn(async (): Promise<{ readonly _tag: "Success"; readonly value?: unknown }> => ({
    _tag: "Success",
  })),
);

vi.mock("react-native", () => ({
  Animated: {},
  Pressable: () => null,
  ScrollView: () => null,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: Children) => <span>{children}</span>,
  View: ({ children }: Children) => <div>{children}</div>,
  useAnimatedValue: () => null,
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition };
  return {
    default: {},
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
    ReduceMotion: {},
    useAnimatedScrollHandler: () => undefined,
    useAnimatedStyle: () => ({}),
    useSharedValue: () => ({}),
    withTiming: () => 0,
  };
});
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@expo/ui/community/masked-view", () => ({ MaskedView: () => null }));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("@effect/atom-react", () => ({
  // The held-session buttons select the source thread's projection, the account button its
  // latest run.
  useAtomValue: (_atom: unknown, select?: (thread: unknown) => unknown) =>
    select === undefined
      ? false
      : select({
          projection: {
            thread: { title: "Held", runtimeMode: "full-access" },
            runs: [
              { id: "run-earlier", ordinal: 1 },
              { id: "run-refused", ordinal: 2 },
            ],
            turnItems: [],
          },
        }),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { v2: { dispatchCommand: { permissionAtom: () => ({}) } } },
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/T3Wordmark", () => ({ T3Wordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled, onPress }: ButtonProps) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/FilePreviewGallery", () => ({ FilePreviewGallery: () => null }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("../../lib/highlights", () => ({}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "forked-thread" }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: () => ({ data: null }) }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => null },
  threadEnvironment: {
    forkFromRun: {},
    mcpSignInStart: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { confirmClaudeThreadAccount: {} } }));
vi.mock("./threadAccountConfirmAccess", () => ({ useThreadAccountConfirmAccess: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => forkFromRun }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({ PullRequestGlyph: () => null }));
vi.mock("./BrowserAppIcon", () => ({ BrowserAppIcon: () => null }));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: () => null }));
vi.mock("./McpSignInSheet", () => ({ McpSignInSheet: () => null }));
vi.mock("./ProposedPlanCard", () => ({ ProposedPlanCard: () => null }));
vi.mock("./QuestionAnswerHistory", () => ({ QuestionAnswerHistory: () => null }));
vi.mock("./thread-command-output", () => ({
  ThreadCommandOutput: () => null,
  useCommandOutputStreaming: () => false,
}));
vi.mock("./thread-subagent-group", () => ({ ThreadSubagentGroup: () => null }));
vi.mock("./threadForkNavigation", () => ({ waitForThreadShell: async () => true }));
vi.mock("./ThreadMarkdownImage", () => ({ ThreadMarkdownImage: () => null }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => vi.fn() }));
vi.mock("./work-log-layout", () => {
  const Plain = ({ children }: Children) => <div>{children}</div>;
  return {
    WorkLogBlock: Plain,
    WorkLogIconSlot: Plain,
    WorkLogLabel: Plain,
    WorkLogPressable: Plain,
    WorkLogRows: Plain,
  };
});

import { ThreadWorkLog } from "./thread-work-log";

const confirmedAccount = {
  apiProvider: "firstParty",
  email: "b@example.com",
  organization: null,
  credentialSource: null,
};
const failedRow = (
  visibility: OrchestrationV2ProjectedTurnItem["visibility"],
  code: string,
  message: string,
  runId = "run-refused",
) =>
  ({
    id: "row-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    summary: "Provider error",
    projectedItem: {
      visibility,
      item: {
        type: "error",
        status: "failed",
        threadId: "thread-held",
        runId,
        failure: {
          class: "provider_error",
          code,
          message,
          accountChange: {
            recorded: { ...confirmedAccount, email: "a@example.com" },
            current: confirmedAccount,
          },
        },
      },
    },
  }) as unknown as Parameters<typeof ThreadWorkLog>[0]["activities"][number];

it.each([
  ["local", ["Send as this account"]],
  ["inherited", []],
] as const)(
  "offers to confirm a changed Claude account on its own thread's row only: %s",
  async (visibility, offered) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forkFromRun.mockClear();
    forkFromRun.mockResolvedValueOnce({ _tag: "Success", value: { outcome: "confirmed" } });
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <ThreadWorkLog
          {...({} as Parameters<typeof ThreadWorkLog>[0])}
          activities={[
            failedRow(
              visibility,
              "claude_thread_account_changed",
              "This thread was sent as a@example.com, but Claude is now signed in as b@example.com.",
            ),
          ]}
          anchorKey="row-1"
          environmentId={"env-1" as EnvironmentId}
          copiedRowId={null}
          expandedRows={{}}
        />,
      ),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(offered);
    await act(async () => buttons[0]?.click());
    expect(forkFromRun.mock.calls).toEqual(
      offered.length === 0
        ? []
        : [
            [
              {
                environmentId: "env-1",
                input: { threadId: "thread-held", account: confirmedAccount },
              },
            ],
          ],
    );
  },
);

const heldRow = (visibility: OrchestrationV2ProjectedTurnItem["visibility"]) =>
  ({
    id: "row-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    summary: "Provider error",
    projectedItem: {
      visibility,
      item: {
        type: "error",
        status: "failed",
        threadId: "thread-held",
        runId: "run-refused",
        failure: {
          class: "provider_error",
          code: "provider_thread_in_use",
          message: "Another Claude Code process has this session open.",
        },
      },
    },
  }) as unknown as Parameters<typeof ThreadWorkLog>[0]["activities"][number];

it.each([
  ["local", ["Fork into a new session"]],
  ["inherited", []],
] as const)(
  "offers a held session's fork on its own thread's row only: %s",
  async (visibility, offered) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forkFromRun.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <ThreadWorkLog
          {...({} as Parameters<typeof ThreadWorkLog>[0])}
          activities={[heldRow(visibility)]}
          anchorKey="row-1"
          environmentId={"env-1" as EnvironmentId}
          copiedRowId={null}
          expandedRows={{}}
        />,
      ),
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(offered);
    await act(async () => buttons[0]?.click());
    expect(forkFromRun.mock.calls).toEqual(
      offered.length === 0
        ? []
        : [
            [
              {
                environmentId: "env-1",
                input: {
                  sourceThreadId: "thread-held",
                  targetThreadId: "forked-thread",
                  runId: "run-refused",
                  title: "Held fork",
                  creationSource: "mobile",
                },
              },
            ],
          ],
    );
  },
);

it("offers no confirmation on a refused row a later run has superseded", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <ThreadWorkLog
        {...({} as Parameters<typeof ThreadWorkLog>[0])}
        activities={[
          failedRow(
            "local",
            "claude_thread_account_changed",
            "This thread was sent as a@example.com, but Claude is now signed in as b@example.com.",
            "run-earlier",
          ),
        ]}
        anchorKey="row-1"
        environmentId={"env-1" as EnvironmentId}
        copiedRowId={null}
        expandedRows={{}}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([]);
});
