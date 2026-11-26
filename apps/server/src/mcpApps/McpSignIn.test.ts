import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { toSignInError } from "./McpSignIn.ts";

describe("toSignInError", () => {
  const generic = "Couldn't start the sign-in to linear.";
  const detailOf = (cause: unknown) =>
    Effect.flip(
      toSignInError({ threadId: ThreadId.make("thread"), server: "linear" }, generic)(cause),
    ).pipe(Effect.map((error) => error.detail));

  it.effect("says why a held session refused the sign-in, and keeps other failures generic", () =>
    Effect.gen(function* () {
      expect(
        yield* detailOf({ _tag: "ProviderAdapterThreadInUseError", holderObserved: true }),
      ).toBe(
        "Another Claude Code process has this thread's session open, so the sign-in to linear was not sent. Close that process and try again.",
      );
      expect(yield* detailOf({ _tag: "ProviderAdapterThreadInUseError" })).toContain(
        "could not check whether another Claude Code process",
      );
      expect(yield* detailOf({ _tag: "ProviderAdapterEventStreamError" })).toBe(generic);
    }),
  );
});
