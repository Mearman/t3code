import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

const remoteInputs = vi.hoisted(() => [] as Array<unknown>);

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? ""),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: { accessibilityLabel: string; onChangeText: (value: string) => void }) => (
    <input
      aria-label={props.accessibilityLabel}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../state/claudeReplication", () => ({
  claudeReplicationEnvironment: {
    report: () => "report",
    replicateNow: "replicateNow",
    remoteSessions: (input: unknown) => {
      remoteInputs.push(input);
      return "remote";
    },
  },
}));
vi.mock("../../state/peerLinks", () => ({ peerLinkEnvironment: { names: () => "names" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === "names"
        ? { links: [{ environmentId: "environment-box", label: "Box" }] }
        : atom === "report"
          ? { lastRunAt: null, sources: [], replicas: [], skipped: [] }
          : atom === "remote"
            ? { sessions: [], nextCursor: null }
            : null,
    error: null,
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThreadRead: () => vi.fn() }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: Children) => <section>{children}</section>,
}));

import { ClaudeReplicationSection } from "./ClaudeReplicationSection";

it("searches the linked machine's sessions by what the user types", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <ClaudeReplicationSection
        environmentId={EnvironmentId.make("environment-here")}
        label="Here"
      />,
    ),
  );
  const search = host.querySelector<HTMLInputElement>(
    "input[aria-label='Search sessions on the linked machine']",
  );
  if (search === null) return expect.unreachable();

  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(search, "login");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(remoteInputs.at(-1)).toEqual({
    environmentId: "environment-here",
    input: { environmentId: "environment-box", query: "login" },
  });
  act(() => root.unmount());
});
