import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Predicate from "effect/Predicate";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as ProviderAuthTerminal from "@t3tools/provider-core/server/providerAuthTerminal";

const CLAUDE_SUBSCRIPTION_METHOD_ID = "claudeai";
const CLAUDE_CONSOLE_METHOD_ID = "console";
const CLAUDE_TERMINAL_METHOD_ID = "terminal";

export interface ClaudeSignInUrls {
  readonly manualUrl: string;
  readonly automaticUrl: string;
}

/** A Claude process that can run the CLI's own OAuth flow through control requests. */
export interface ClaudeLoginSession {
  readonly authenticate: (
    loginWithClaudeAi: boolean,
  ) => Effect.Effect<ClaudeSignInUrls, ClaudeControlLoginUnavailable | ProviderSetupError>;
  readonly submitCode: (
    authorizationCode: string,
    state: string,
  ) => Effect.Effect<void, ProviderSetupError>;
  /** Ends when the sign-in completes through the automatic link's local redirect. */
  readonly awaitAutomaticCompletion: Effect.Effect<void, ProviderSetupError>;
}

/** The CLI or SDK cannot run sign-in through control requests; the terminal is the fallback. */
export class ClaudeControlLoginUnavailable extends Schema.TaggedError<ClaudeControlLoginUnavailable>()(
  "ClaudeControlLoginUnavailable",
  {},
) {}

// `claude auth status --json`; 2.1.309 reports no token expiry, so only sign-in state is read.
const decodeClaudeAuthStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })),
);

const UNSUPPORTED_SUBTYPE = "Unsupported control request subtype";

const pageOf = (url: URL) => `${url.origin}${url.pathname}`;

/**
 * Reads a pasted sign-in answer: the bare code Claude's page shows, `code#state`, or the redirect
 * URL carrying `code` and `state`. The state must match this flow's; a pasted sign-in link
 * (`signInLinks`) is not an answer, though it also carries a `code` and the state.
 */
export function parseClaudeAuthorizationPaste(
  pasted: string,
  expectedState: string,
  signInLinks: ReadonlyArray<string>,
):
  | { readonly authorizationCode: string; readonly state: string }
  | "invalid"
  | "wrongFlow"
  | "signInLink" {
  const text = pasted.trim();
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (
    url !== undefined &&
    signInLinks.some((link) => URL.canParse(link) && pageOf(new URL(link)) === pageOf(url))
  )
    return "signInLink";
  const [code, state] = url
    ? [url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? ""]
    : text.includes("#")
      ? [text.slice(0, text.indexOf("#")), text.slice(text.indexOf("#") + 1)]
      : [text, expectedState];
  if (code.length === 0 || /\s/u.test(code)) return "invalid";
  if (state !== expectedState) return "wrongFlow";
  return { authorizationCode: code, state };
}

const signInState = (manualUrl: string): string | undefined =>
  URL.canParse(manualUrl) ? (new URL(manualUrl).searchParams.get("state") ?? undefined) : undefined;

function controlMethod(query: object, name: string) {
  const method: unknown = Reflect.get(query, name);
  return typeof method === "function"
    ? async (...args: ReadonlyArray<unknown>): Promise<unknown> =>
        await Reflect.apply(method, query, args)
    : undefined;
}

const reasonOf = (cause: unknown) =>
  Predicate.isObject(cause) && typeof cause.message === "string" ? cause.message : "";

/**
 * Wraps an initialised SDK query. SDK 0.3.321 ships `claudeAuthenticate`, `claudeOAuthCallback` at
 * runtime without types, so they are found by name; a missing one means no control login.
 */
export const makeClaudeQueryLoginSession = (
  instanceId: ProviderInstanceId,
  query: object,
): ClaudeLoginSession => {
  // The SDK's error can quote the link or the code, so only its redacted text is kept, in both
  // the detail and the cause that spans and logs record.
  const failure = (operation: string, detail: string, cause: unknown) => {
    const reason = ProviderAuthTerminal.redactSignInSecrets(reasonOf(cause));
    return new ProviderSetupError({
      instanceId,
      operation,
      detail: ProviderAuthTerminal.appendDetail(detail, reason),
      cause: reason,
    });
  };
  return {
    authenticate: Effect.fn("ClaudeQueryLoginSession.authenticate")(function* (
      loginWithClaudeAi: boolean,
    ) {
      const authenticate = controlMethod(query, "claudeAuthenticate");
      if (authenticate === undefined) return yield* new ClaudeControlLoginUnavailable();
      const reply = yield* Effect.tryPromise({
        try: () => authenticate(loginWithClaudeAi),
        catch: (cause) =>
          reasonOf(cause).includes(UNSUPPORTED_SUBTYPE)
            ? new ClaudeControlLoginUnavailable()
            : failure("start", "Claude could not start sign-in.", cause),
      });
      if (
        !Predicate.isObject(reply) ||
        typeof reply.manualUrl !== "string" ||
        typeof reply.automaticUrl !== "string"
      )
        return yield* new ProviderSetupError({
          instanceId,
          operation: "start",
          detail: "Claude did not return a sign-in link.",
        });
      return { manualUrl: reply.manualUrl, automaticUrl: reply.automaticUrl };
    }),
    submitCode: Effect.fn("ClaudeQueryLoginSession.submitCode")(function* (
      authorizationCode: string,
      state: string,
    ) {
      const callback = controlMethod(query, "claudeOAuthCallback");
      if (callback === undefined)
        return yield* new ProviderSetupError({
          instanceId,
          operation: "respond",
          detail: "This Claude Code version cannot accept a sign-in code.",
        });
      yield* Effect.tryPromise({
        try: () => callback(authorizationCode, state),
        catch: (cause) => failure("respond", "Claude did not accept the sign-in code.", cause),
      });
    }),
    awaitAutomaticCompletion: Effect.suspend(() => {
      const wait = controlMethod(query, "claudeOAuthWaitForCompletion");
      // Without the request the flow can still finish through a pasted code.
      return wait === undefined
        ? Effect.never
        : Effect.tryPromise({
            try: () => wait(),
            catch: (cause) => failure("verify", "Claude could not finish signing in.", cause),
          }).pipe(Effect.asVoid);
    }),
  };
};

export interface ClaudeAuthOptions {
  readonly instanceId: ProviderInstanceId;
  /** Instances on the same config folder share one Claude login. */
  readonly configDir: string;
  readonly openLoginSession: Effect.Effect<ClaudeLoginSession, ProviderSetupError, Scope.Scope>;
  /** Runs `binaryPath <args>` with the instance's environment. */
  readonly runCommand: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly stdout: string; readonly code: number }, ProviderSetupError>;
  readonly terminal: Omit<PtyAdapter.PtySpawnInput, "cols" | "rows" | "args">;
  readonly onChanged: Effect.Effect<void>;
}

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: ClaudeAuthOptions) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const fail = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const methods: ReadonlyArray<ProviderAuthMethod> = [
    {
      id: CLAUDE_SUBSCRIPTION_METHOD_ID,
      name: "Claude subscription",
      description: "Pro, Max, Team or Enterprise plan.",
      type: "agent",
    },
    {
      id: CLAUDE_CONSOLE_METHOD_ID,
      name: "Anthropic Console",
      description: "API usage billing.",
      type: "agent",
    },
    ...(Option.isSome(pty)
      ? [
          {
            id: CLAUDE_TERMINAL_METHOD_ID,
            name: "Terminal",
            description: "Runs claude auth login on this environment.",
            type: "terminal" as const,
          },
        ]
      : []),
  ];

  const status = options
    .runCommand(["auth", "status", "--json"])
    .pipe(
      Effect.flatMap((result) =>
        Effect.fromOption(decodeClaudeAuthStatus(result.stdout), () =>
          fail("verify", "Claude did not report its sign-in status."),
        ),
      ),
    );

  const runTerminal = (
    loginWithClaudeAi: boolean,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) =>
    Option.isNone(pty)
      ? Effect.fail(fail("start", "Interactive sign-in is unavailable on this environment."))
      : ProviderAuthTerminal.runProviderAuthTerminal({
          instanceId: options.instanceId,
          pty: pty.value,
          spawn: {
            ...options.terminal,
            args: ["auth", "login", loginWithClaudeAi ? "--claudeai" : "--console"],
          },
          context,
        }).pipe(Effect.scoped);

  const signInWithCode = Effect.fn("ClaudeAuth.signInWithCode")(function* (
    loginWithClaudeAi: boolean,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const session = yield* options.openLoginSession;
    const urls = yield* session.authenticate(loginWithClaudeAi);
    const expectedState = signInState(urls.manualUrl);
    if (expectedState === undefined)
      return yield* fail("start", "Claude returned a sign-in link without a state.");
    const answer = yield* Deferred.make<{
      readonly authorizationCode: string;
      readonly state: string;
    }>();
    // The exchange runs on the flow fiber, not inside `complete`, which holds the flow's lock.
    // `url` is the automatic link: a browser on this machine finishes through the CLI's local
    // redirect, and a client without `codeUrl` takes the failed redirect's address as a URL.
    yield* context.setInteraction(
      {
        type: "browser",
        id: "claude-oauth",
        url: urls.automaticUrl,
        codeUrl: urls.manualUrl,
        requiresConsent: false,
        acceptsCallback: true,
        callbackInput: "code",
      },
      undefined,
      (pasted) => {
        const parsed = parseClaudeAuthorizationPaste(pasted, expectedState, [
          urls.manualUrl,
          urls.automaticUrl,
        ]);
        if (parsed === "signInLink")
          return Effect.fail(
            fail(
              "complete",
              "That is the sign-in link. Open it, sign in, then paste the code the page shows.",
            ),
          );
        if (parsed === "invalid")
          return Effect.fail(fail("complete", "Paste the code shown after you sign in."));
        if (parsed === "wrongFlow")
          return Effect.fail(
            fail(
              "complete",
              "That code belongs to a different sign-in. Open the link again and paste the new code.",
            ),
          );
        return Deferred.succeed(answer, parsed).pipe(Effect.asVoid);
      },
    );
    yield* Effect.raceFirst(
      session.awaitAutomaticCompletion,
      Effect.gen(function* () {
        const { authorizationCode, state } = yield* Deferred.await(answer);
        yield* context.verifying;
        yield* session.submitCode(authorizationCode, state);
      }),
    );
  });

  const authenticate = Effect.fn("ClaudeAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const loginWithClaudeAi = methodId !== CLAUDE_CONSOLE_METHOD_ID;
    if (methodId === CLAUDE_TERMINAL_METHOD_ID) yield* runTerminal(true, context);
    else
      yield* signInWithCode(loginWithClaudeAi, context).pipe(
        Effect.catchTags({
          ClaudeControlLoginUnavailable: () => runTerminal(loginWithClaudeAi, context),
        }),
      );
    yield* context.verifying;
    if (!(yield* status).loggedIn)
      return yield* fail("verify", "Claude did not report a signed-in account. Start again.");
    yield* options.onChanged;
  });

  const logout = Effect.gen(function* () {
    const result = yield* options.runCommand(["auth", "logout"]);
    if (result.code !== 0) return yield* fail("logout", "Claude could not sign out.");
    yield* options.onChanged;
    return "Signed out of Claude.";
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed(methods),
    defaultMethodId: CLAUDE_SUBSCRIPTION_METHOD_ID,
    authenticate,
    logout,
  });
});
