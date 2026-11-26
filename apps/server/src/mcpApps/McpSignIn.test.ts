import { describe, expect, it } from "@effect/vitest";

import { signInFailureDetail } from "./McpSignIn.ts";

describe("signInFailureDetail", () => {
  it("says why a held session refused the sign-in, and keeps other failures generic", () => {
    const generic = "Couldn't start the sign-in to linear.";
    expect(
      signInFailureDetail(
        { _tag: "ProviderAdapterThreadInUseError", holderObserved: true },
        "linear",
        generic,
      ),
    ).toBe(
      "Another Claude Code process has this thread's session open, so the sign-in to linear was not sent. Close that process and try again.",
    );
    expect(
      signInFailureDetail({ _tag: "ProviderAdapterThreadInUseError" }, "linear", generic),
    ).toContain("could not check whether another Claude Code process");
    expect(
      signInFailureDetail({ _tag: "ProviderAdapterEventStreamError" }, "linear", generic),
    ).toBe(generic);
  });
});
