// @effect-diagnostics nodeBuiltinImport:off - Bundles packages/shared the way the build configs do.
import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";
import { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Rolldown } from "vite-plus/pack";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { releaseRepositoryDefine, resolveReleaseRepository } from "./release-repository.ts";

it("prefers the desktop update repository over the CI repository", () => {
  expect(
    resolveReleaseRepository({
      T3CODE_DESKTOP_UPDATE_REPOSITORY: " owner/mirror ",
      GITHUB_REPOSITORY: "owner/fork",
    }),
  ).toBe("owner/mirror");
  expect(resolveReleaseRepository({ GITHUB_REPOSITORY: "owner/fork" })).toBe("owner/fork");
  expect(
    resolveReleaseRepository({ T3CODE_DESKTOP_UPDATE_REPOSITORY: "", GITHUB_REPOSITORY: "o/r" }),
  ).toBe("o/r");
});

it("leaves the upstream default in place when no repository is configured", () => {
  expect(resolveReleaseRepository({})).toBeUndefined();
  expect(releaseRepositoryDefine({ GITHUB_REPOSITORY: " " })).toEqual({});
});

it.each(["owner", "owner/name/extra", "owner/..", "own er/name", "/name"])(
  "refuses the malformed repository %j",
  (repository) => {
    expect(() => resolveReleaseRepository({ GITHUB_REPOSITORY: repository })).toThrow("owner/name");
  },
);

it("defines the repository as a string literal for the bundle", () => {
  expect(releaseRepositoryDefine({ GITHUB_REPOSITORY: "owner/fork" })).toEqual({
    __T3CODE_RELEASE_REPOSITORY__: '"owner/fork"',
  });
});

it("points a bundle's release URLs at the repository its build defines", async () => {
  const bundle = await Rolldown.rolldown({
    input: NodePath.resolve(import.meta.dirname, "../../packages/shared/src/cliRelease.ts"),
    platform: "node",
    transform: { define: releaseRepositoryDefine({ GITHUB_REPOSITORY: "owner/fork" }) },
  });
  try {
    const { output } = await bundle.generate({ format: "esm", codeSplitting: false });
    const source = NodeBuffer.Buffer.from(output[0].code).toString("base64");
    const loaded: unknown = await import(`data:text/javascript;base64,${source}`);
    expect(loaded).toMatchObject({
      CLI_RELEASE_REPOSITORY: "owner/fork",
      CLI_RELEASES_PAGE_URL: "https://github.com/owner/fork/releases",
    });
  } finally {
    await bundle.close();
  }
});

const FORK_DEFINE = { __T3CODE_RELEASE_REPOSITORY__: '"owner/fork"' };
const loadBuildConfig = async (configPath: string): Promise<unknown> => {
  vi.stubEnv("GITHUB_REPOSITORY", "owner/fork");
  vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", "");
  vi.resetModules();
  return import(NodePath.resolve(import.meta.dirname, "../..", configPath));
};

afterEach(() => vi.unstubAllEnvs());

it("builds the server bundle with the release repository define", async () => {
  expect(await loadBuildConfig("apps/server/vite.config.ts")).toMatchObject({
    default: { pack: { define: FORK_DEFINE } },
  });
});

it("builds the desktop main process with the release repository define", async () => {
  expect(await loadBuildConfig("apps/desktop/vite.config.ts")).toMatchObject({
    default: {
      pack: expect.arrayContaining([
        expect.objectContaining({
          entry: ["src/main.ts"],
          define: expect.objectContaining(FORK_DEFINE),
        }),
      ]),
    },
  });
});

// Every string of up to five characters from this alphabet, which covers each class the two
// checks distinguish: segment characters, separators, dots, and anything else.
const CANDIDATE_ALPHABET = ["a", "Z", "0", ".", "_", "-", "/", " "];
const candidates = (length: number): ReadonlyArray<string> =>
  length === 0
    ? [""]
    : candidates(length - 1).flatMap((prefix) => CANDIDATE_ALPHABET.map((c) => prefix + c));

it("accepts exactly the release repositories a server may report to clients", () => {
  const decodes = Schema.is(ExecutionEnvironmentCapabilities);
  const disagreements: string[] = [];
  for (let length = 1; length <= 5; length++) {
    for (const value of candidates(length)) {
      let resolved: string | undefined;
      try {
        resolved = resolveReleaseRepository({ GITHUB_REPOSITORY: value });
      } catch {
        resolved = undefined;
      }
      const reported = resolved === value;
      const capabilities = { repositoryIdentity: true, serverReleaseRepository: value };
      if (reported !== decodes(capabilities)) disagreements.push(value);
    }
  }
  expect(disagreements).toEqual([]);
});
