import { EnvironmentId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
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
// The app's debounce, without the Expo modules its file also loads.
vi.mock("../../state/queries", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useDebouncedValue: <A,>(value: A, delayMs: number) => {
      const [settled, setSettled] = useState(value);
      useEffect(() => {
        const timer = setTimeout(() => setSettled(value), delayMs);
        return () => clearTimeout(timer);
      }, [delayMs, value]);
      return settled;
    },
  };
});
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThreadRead: () => vi.fn() }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: Children) => <section>{children}</section>,
}));

import { ClaudeReplicationSection } from "./ClaudeReplicationSection";

it("searches the linked machine's sessions once typing settles", () => {
  vi.useFakeTimers();
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

  const type = (text: string) =>
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const listedBefore = remoteInputs.length;
  for (const text of ["l", "lo", "log", "logi", "login"]) type(text);
  const queried = () =>
    remoteInputs
      .slice(listedBefore)
      .flatMap((input) =>
        Predicate.hasProperty(input, "input") &&
        Predicate.hasProperty(input.input, "query") &&
        typeof input.input.query === "string"
          ? [input.input.query]
          : [],
      );
  expect(queried()).toEqual([]);
  act(() => vi.advanceTimersByTime(300));
  expect(new Set(queried())).toEqual(new Set(["login"]));

  expect(remoteInputs.at(-1)).toEqual({
    environmentId: "environment-here",
    input: { environmentId: "environment-box", query: "login" },
  });
  act(() => root.unmount());
  vi.useRealTimers();
});
