import { describe, expect, it } from "@effect/vitest";

import { matchesCwdGlob } from "./claudeCwdGlobs.ts";

const home = "/Users/me";
const matches = (glob: string, cwd: string) => matchesCwdGlob({ glob, cwd, home });

describe("matchesCwdGlob", () => {
  it("keeps single stars within a segment and double stars across them", () => {
    expect(matches("/work/*", "/work/project")).toBe(true);
    expect(matches("/work/*", "/work/project/sub")).toBe(false);
    expect(matches("/work/**", "/work/project/sub")).toBe(true);
    expect(matches("/work/p?oject", "/work/project")).toBe(true);
  });

  it("matches a directory itself under a trailing double star, and expands the home", () => {
    expect(matches("/work/**", "/work")).toBe(true);
    expect(matches("/work/**", "/workshop")).toBe(false);
    expect(matches("~/scratch/**", "/Users/me/scratch/a")).toBe(true);
    expect(matches("~other/**", "/Users/meother/x")).toBe(false);
  });

  it("treats other pattern characters literally", () => {
    expect(matches("/work/a.b", "/work/axb")).toBe(false);
    expect(matches("/work/(x)", "/work/(x)")).toBe(true);
  });
});
