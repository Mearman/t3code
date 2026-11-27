import { assert, it } from "@effect/vitest";

import { lastPrintedLines, redactSignInSecrets } from "./providerAuthTerminal.ts";

it("keeps a login command's reason but never its sign-in link or a pasted code", () => {
  const code = "test-only-0123456789abcdefghijklmnop#state";
  const output = [
    "Opening browser to sign in…",
    "\u001b[1mBrowser didn't open? Use the url below to sign in:\u001b[0m",
    "https://claude.ai/oauth/authorize?code=true&client_id=test-only&state=s",
    `Paste code here if prompted > ${code}`,
    "OAuth error: Request failed with status code 400",
  ].join("\r\n");
  const printed = lastPrintedLines(output);
  assert.notInclude(printed, "https://");
  assert.notInclude(printed, "client_id");
  assert.notInclude(printed, code);
  assert.include(printed, "OAuth error: Request failed with status code 400");
  assert.strictEqual(redactSignInSecrets("Network unreachable."), "Network unreachable.");
});
