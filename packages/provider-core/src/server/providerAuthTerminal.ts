import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import type { ProviderAuthFlowContext } from "./providerAuthFlow.ts";

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_LOGIN_OUTPUT_LINES = 5;

/** Appends a provider's own reason to safe setup text, truncated so a long log cannot flood it. */
export const appendDetail = (detail: string, reason: string): string => {
  let message = reason.trim();
  if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH).trimEnd()}…`;
  }
  if (message.length === 0) return detail;
  const trimmed = detail.trimEnd();
  const prefix = trimmed.endsWith(".") ? `${trimmed} ` : `${trimmed}. `;
  return `${prefix}${message}`;
};

// Sign-in commands print their URL and a PTY echoes a pasted code, so neither may reach the error.
// A link the terminal wrapped continues on lines without its scheme, so any word carrying URL
// punctuation is treated as part of one.
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
const LINK_PART = /\S*[/?&=%#]\S*/gu;
const TOKEN_LIKE = /[\w#~.+/=-]{24,}/gu;

/** Replaces links, wrapped link fragments and code-like runs, which an error must never carry. */
export const redactSignInSecrets = (text: string): string =>
  text.replace(LINK, "[link]").replace(TOKEN_LIKE, "[redacted]").replace(LINK_PART, "[redacted]");

/** The last lines a login command printed, with links and code-like runs replaced. */
export const lastPrintedLines = (output: string): string => {
  const lines = redactSignInSecrets(NodeUtil.stripVTControlCharacters(output))
    .split("\n")
    .map((line) => line.trimEnd())
    // A carriage return inside a line redraws it, so only the text after the last one is visible.
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_LOGIN_OUTPUT_LINES)
    .join(" ");
  return lines.length > MAX_ERROR_MESSAGE_LENGTH
    ? `…${lines.slice(-MAX_ERROR_MESSAGE_LENGTH).trimStart()}`
    : lines;
};

/**
 * Runs a provider's interactive login command in a PTY and mirrors it to the client as a `terminal`
 * interaction. Succeeds when the command exits 0; any other exit fails with the command's last
 * printed lines with links and code-like runs redacted.
 */
export const runProviderAuthTerminal = Effect.fnUntraced(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly spawn: Omit<PtyAdapter.PtySpawnInput, "cols" | "rows">;
  readonly context: ProviderAuthFlowContext;
}) {
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const exited = yield* Deferred.make<number>();
  const output = yield* Queue.sliding<string>(64);
  const process = yield* options.pty
    .spawn({ ...options.spawn, cols: 80, rows: 24 })
    .pipe(
      Effect.mapError((cause) =>
        failure("start", "Could not open the provider sign-in terminal.", cause),
      ),
    );
  // Kept in the callback so output that arrives just before exit is not lost to the reader.
  let printed = "";
  const detachData = process.onData((data) => {
    printed = (printed + data).slice(-4_096);
    Queue.offerUnsafe(output, data.slice(-16_384));
  });
  const detachExit = process.onExit(({ exitCode }) => {
    Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      detachData();
      detachExit();
      try {
        process.kill();
      } catch {}
    }),
  );
  let transcript = "";
  let outputOffset = 0;
  const update = () =>
    options.context.setInteraction(
      { type: "terminal", id: "terminal", output: transcript, outputOffset },
      (response) =>
        response.type === "terminal"
          ? Effect.try({
              try: () => {
                if (response.size) process.resize(response.size.cols, response.size.rows);
                if (response.data)
                  process.write(PtyAdapter.ptyInput(response.data, response.binary));
              },
              catch: () =>
                failure("respond", "The provider sign-in terminal is no longer available."),
            })
          : Effect.void,
    );
  yield* update();
  yield* Queue.take(output).pipe(
    Effect.flatMap((data) => {
      outputOffset += data.length;
      transcript = (transcript + data).slice(-16_384);
      return update();
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  if ((yield* Deferred.await(exited)) !== 0)
    return yield* failure(
      "start",
      appendDetail(
        "The provider login command did not finish successfully.",
        lastPrintedLines(printed),
      ),
    );
});
