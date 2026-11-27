import { expect, it } from "vite-plus/test";

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
