import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const asked = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock(import("../../state/peerLinks"), async (original) => ({
  ...(await original()),
  peerLinkEnvironment: {
    ...(await original()).peerLinkEnvironment,
    names: () => "names" as never,
  },
}));
vi.mock(import("../../state/claudeReplication"), async (original) => ({
  ...(await original()),
  claudeReplicationEnvironment: {
    ...(await original()).claudeReplicationEnvironment,
    remoteSessions: (key: { readonly input: { readonly query?: string } }) => {
      asked.push(key.input.query);
      return "remote" as never;
    },
  },
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "names"
        ? { links: [{ environmentId: "environment-box", label: "Box" }] }
        : { sessions: [], nextCursor: null },
    error: null,
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn() as never,
}));

import { LinkedSessions } from "./ClaudeSessionReplicationSettings";

it("asks the linked machine for what the user types, once typing settles, without Enter", async () => {
  await using screen = await render(
    <LinkedSessions environmentId={EnvironmentId.make("environment-here")} />,
  );
  const search = screen.getByRole("searchbox", { name: "Search sessions on the linked machine" });

  for (const typed of ["l", "lo", "log", "logi", "login"]) await search.fill(typed);

  await expect.poll(() => asked.at(-1)).toBe("login");
  expect(asked.filter((query) => query !== undefined)).toEqual(["login"]);
});
