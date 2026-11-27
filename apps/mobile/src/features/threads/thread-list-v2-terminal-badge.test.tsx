import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

type Children = { children?: ReactNode };
type RowProps = Children & { accessibilityLabel?: string };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: ({ children }: Children) => <div>{children}</div>,
  Text: ({ children }: Children) => <span>{children}</span>,
  View: ({ children }: Children) => <div>{children}</div>,
  useWindowDimensions: () => ({ width: 400, fontScale: 1 }),
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: Children) => children,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("../../i18n/messages", () => ({ m: (text: string) => text }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: ({ children, accessibilityLabel }: RowProps) => (
    <div data-testid="row" data-label={accessibilityLabel}>
      {children}
    </div>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/Menu", () => ({ Menu: ({ children }: Children) => children }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => null,
  ProviderInstanceIcon: () => null,
  providerInstanceNameLabel: () => null,
}));
vi.mock("../../lib/clock", () => ({ useNowAfter: () => 0 }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../lib/copyThreadReference", () => ({ copyThreadReference: vi.fn() }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentScopeDenied: () => false,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { pendingSyncAtom: () => ({}) } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/queries", () => ({ useBranches: () => ({ data: null }) }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../../state/thread-pr-presentation", () => ({
  resolveThreadPrBadgeAction: () => ({ accessibilityLabel: "" }),
}));
vi.mock("../../state/use-pending-new-tasks", () => ({}));
vi.mock("../../state/pending-new-tasks-model", () => ({}));
vi.mock("./use-new-task-project-defaults", () => ({ useNewTaskProjectDefaults: () => null }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("./queued-message-icon", () => ({ QueuedMessageIcon: () => null }));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));
vi.mock("./thread-title-regeneration-menu", () => ({
  buildThreadTitleRegenerationMenuItems: () => [],
}));
vi.mock("./turnThreadIntoProject", () => ({
  canTurnThreadIntoProject: () => false,
  turnThreadIntoProject: vi.fn(),
}));
vi.mock("./useCanShareWithGuest", () => ({ useCanShareWithGuest: () => false }));
vi.mock("../home/swipe-row-activation", () => ({ useSwipeRowDormant: () => false }));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: ({ children }: { children: (close: () => void) => ReactNode }) =>
    children(() => undefined),
}));
vi.mock("../home/threadArchive", () => ({ threadCanArchive: () => false }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 20 }),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({ PullRequestGlyph: {} }));
vi.mock("../pull-requests/pullRequestStatus", () => ({ pullRequestStatus: () => ({}) }));
vi.mock("./thread-list-v2-row-appearance", async (original) => ({
  ...(await original<typeof import("./thread-list-v2-row-appearance")>()),
  getThreadListV2RowAppearance: () => ({
    className: "",
    interactionClassName: "",
    interactionOpacity: 1,
    foregroundClassName: "",
    mutedForegroundClassName: "",
    tertiaryForegroundClassName: "",
    cardStyle: undefined,
  }),
}));

import { ThreadListV2Row } from "./thread-list-v2-items";

const environmentId = EnvironmentId.make("environment-1");
const noop = () => undefined;

function renderRow(thread: EnvironmentThreadShell) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const props: ComponentProps<typeof ThreadListV2Row> = {
    thread,
    variant: "card",
    providers: undefined,
    providerInstance: null,
    environmentLabel: null,
    project: undefined,
    timeLabel: "5m",
    onSelectThread: noop,
    onOpenThreadPullRequests: noop,
    onDeleteThread: noop,
    onNewThreadOnBranch: noop,
    onRenameThread: noop,
    onRegenerateThreadTitle: noop,
    onSettleThread: async () => true,
    onSnoozeThread: noop,
    onUnsnoozeThread: noop,
    onUnsettleThread: noop,
    onArchiveThread: noop,
    onPinThread: noop,
    onUnpinThread: noop,
    onSetThreadAutoSettle: noop,
    settlementSupported: false,
    snoozeSupported: false,
    snoozePresets: undefined,
    pinningSupported: false,
    autoSettleOptOutSupported: false,
    titleRegenerationSupported: false,
    onSwipeableWillOpen: noop,
    onSwipeableClose: noop,
  } as unknown as ComponentProps<typeof ThreadListV2Row>;
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<ThreadListV2Row {...props} />));
  const unmount = () => act(() => root.unmount());
  return { host, unmount };
}

function threadWith(external: boolean) {
  const shell = makeThreadShellFixture({ environmentId, id: ThreadId.make("thread") });
  return {
    ...shell,
    title: "Fix login",
    latestRun: {
      runId: "run-1" as never,
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
      ...(external ? { external: true as const } : {}),
    },
  };
}

it("shows a Terminal badge and says so to VoiceOver on a thread whose latest run came from a terminal", () => {
  const { host, unmount } = renderRow(threadWith(true));
  expect(host.textContent).toContain("Terminal");
  expect(host.querySelector("[data-testid=row]")?.getAttribute("data-label")).toContain(
    "from a terminal",
  );
  unmount();
});

it("shows no Terminal badge on a thread the app ran", () => {
  const { host, unmount } = renderRow(threadWith(false));
  expect(host.textContent).not.toContain("Terminal");
  expect(host.querySelector("[data-testid=row]")?.getAttribute("data-label")).not.toContain(
    "from a terminal",
  );
  unmount();
});
