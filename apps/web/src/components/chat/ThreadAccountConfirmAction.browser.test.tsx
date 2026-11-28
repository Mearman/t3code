import { CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE } from "@t3tools/provider-core/client";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  confirm: vi.fn(),
  toast: vi.fn(),
  runs: [] as ReadonlyArray<{ readonly id: string; readonly ordinal: number }>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.confirm }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { confirmClaudeThreadAccount: { permissionAtom: () => null } },
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadProjection: () => ({ projection: { runs: state.runs } }),
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { claudeThreadAccounts: true } } }]]),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

import { ThreadAccountConfirmAction } from "./ThreadAccountConfirmAction";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
const current = {
  apiProvider: "firstParty",
  email: "b@example.com",
  organization: null,
  credentialSource: null,
};
const row = {
  visibility: "local",
  item: {
    threadId,
    runId: RunId.make("run-refused"),
    failure: {
      code: CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE,
      accountChange: { recorded: { ...current, email: "a@example.com" }, current },
    },
  },
} as const;

const setup = (latest: string) => {
  state.confirm.mockReset();
  state.toast.mockReset();
  state.runs = [
    { id: "run-earlier", ordinal: 1 },
    { id: latest, ordinal: 2 },
  ];
};

it("offers the confirmation only on the thread's latest run", async () => {
  setup("run-later");
  await using screen = await render(
    <ThreadAccountConfirmAction environmentId={environmentId} row={row} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Send as this account" }))
    .not.toBeInTheDocument();
});

it.each([
  [
    "confirmed",
    AsyncResult.success({ outcome: "confirmed" }),
    {
      type: "success",
      title: "Account confirmed",
      description: "Anything refused before was not sent, so send it again.",
    },
  ],
  [
    "stale",
    AsyncResult.success({ outcome: "stale" }),
    { type: "info", title: "Claude is now signed in as another account. Send again to see which." },
  ],
  [
    "none",
    AsyncResult.success({ outcome: "none" }),
    { type: "info", title: "This thread has no account change to confirm." },
  ],
  [
    "failed",
    AsyncResult.failure(Cause.fail(new Error("The server is not reachable."))),
    {
      type: "error",
      title: "Could not confirm the account",
      description: "The server is not reachable.",
    },
  ],
] as const)(
  "sends the account the row names and says what happened: %s",
  async (_, result, toast) => {
    setup("run-refused");
    state.confirm.mockResolvedValueOnce(result);
    await using screen = await render(
      <ThreadAccountConfirmAction environmentId={environmentId} row={row} />,
    );
    const button = screen.getByRole("button", { name: "Send as this account" });
    await button.click();
    await expect.element(button).toBeEnabled();
    expect(state.confirm).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, account: current },
    });
    expect(state.toast).toHaveBeenCalledWith(toast);
  },
);
