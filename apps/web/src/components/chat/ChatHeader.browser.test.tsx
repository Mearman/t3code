import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {}, readMenu: () => null }),
}));

import "../../index.css";
import { render, stubGlobal } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

const project: EnvironmentProject = {
  environmentId: EnvironmentId.make("environment"),
  id: ProjectId.make("project"),
  title: "Claude sessions",
  workspaceRoot: "/work/claude-sessions",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
};

function header(
  title: string,
  fromTerminal = false,
  activeProject: EnvironmentProject | null = null,
) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        activeThreadFromTerminal={fromTerminal}
        isServerThread
        activeProject={activeProject}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("keeps the Escape that cancels a rename from also reaching window shortcuts", async () => {
  persisted.title = "New thread";
  await using screen = await render(header(persisted.title));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await input.fill("Unsaved title");

  // The thread find bar closes from a window keydown listener that skips handled events.
  const windowEscapes: boolean[] = [];
  const recordEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") windowEscapes.push(event.defaultPrevented);
  };
  window.addEventListener("keydown", recordEscape);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", recordEscape),
  };
  await userEvent.keyboard("{Escape}");

  await expect.element(input).not.toBeInTheDocument();
  expect(persisted.title).toBe("New thread");
  expect(windowEscapes).toEqual([true]);
});

it("marks a thread whose latest run came from a terminal, and no other", async () => {
  await using screen = await render(header("Synced session", true));
  await expect.element(screen.getByText("Terminal", { exact: true })).toBeInTheDocument();
  await screen.rerender(header("Synced session", false));
  await expect.element(screen.getByText("Terminal", { exact: true })).not.toBeInTheDocument();
});

function terminalBadge(screen: Awaited<ReturnType<typeof render>>) {
  const label = screen.getByText("Terminal", { exact: true }).element();
  const badge = label.parentElement;
  if (!(badge instanceof HTMLElement)) throw new Error("The terminal label has no badge.");
  return { label, badge, icon: badge.querySelector("svg") };
}

it("keeps space around the terminal badge on both sides when the title fills the row", async () => {
  const longTitle = "Refactor the config parser to return a result instead of throwing ".repeat(8);
  await using screen = await render(header(longTitle, true));
  const title = screen.getByRole("button", { name: `Thread actions for ${longTitle}` }).element();
  const { badge } = terminalBadge(screen);
  const item = badge.parentElement;
  expect(badge.getBoundingClientRect().left - title.getBoundingClientRect().right).toBeGreaterThan(
    0,
  );
  expect(
    (item?.getBoundingClientRect().right ?? 0) - badge.getBoundingClientRect().right,
  ).toBeGreaterThan(0);
});

it("shows the terminal badge as an icon on a narrow screen, with its label for screen readers", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using screen = await render(header("Refactor the config parser", true));
  const { label, icon } = terminalBadge(screen);
  expect(icon).not.toBeNull();
  expect(icon?.getBoundingClientRect().width).toBeGreaterThan(0);
  // Visually hidden, yet still the badge's accessible text.
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  expect(label.textContent).toBe("Terminal");
});

it("shows the terminal badge as its label on a wide screen", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using screen = await render(header("Refactor the config parser", true));
  const { label, icon } = terminalBadge(screen);
  expect(label.getBoundingClientRect().width).toBeGreaterThan(1);
  expect(icon === null || icon.getBoundingClientRect().width === 0).toBe(true);
});

it("leaves the title more room than the project crumb on a narrow screen", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const title = "Refactor the config parser to return a result instead of throwing";
  await using screen = await render(header(title, true, project));
  const crumb = screen.getByRole("button", { name: "New thread in Claude sessions" }).element();
  const heading = screen.getByRole("button", { name: `Thread actions for ${title}` }).element();
  expect(heading.getBoundingClientRect().width).toBeGreaterThan(
    crumb.getBoundingClientRect().width,
  );
});
