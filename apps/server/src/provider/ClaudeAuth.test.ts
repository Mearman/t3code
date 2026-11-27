import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import {
  ClaudeControlLoginUnavailable,
  makeClaudeAuth,
  makeClaudeQueryLoginSession,
  parseClaudeAuthorizationPaste,
  type ClaudeLoginSession,
} from "./ClaudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude-auth-test");
const state = "test-only-state";
const manualUrl = `https://claude.ai/oauth/authorize?code=true&state=${state}`;
const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it("reads a bare code, code#state and a redirect URL, refusing another flow's state", () => {
  const expected = { authorizationCode: "test-only-code", state };
  assert.deepEqual(parseClaudeAuthorizationPaste(" test-only-code ", state), expected);
  assert.deepEqual(parseClaudeAuthorizationPaste(`test-only-code#${state}`, state), expected);
  assert.deepEqual(
    parseClaudeAuthorizationPaste(
      `https://console.anthropic.com/oauth/code/callback?code=test-only-code&state=${state}`,
      state,
    ),
    expected,
  );
  assert.strictEqual(parseClaudeAuthorizationPaste("test-only-code#other", state), "wrongFlow");
  assert.strictEqual(parseClaudeAuthorizationPaste("   ", state), "invalid");
  assert.strictEqual(parseClaudeAuthorizationPaste("two words", state), "invalid");
});

interface Fakes {
  readonly session?: Partial<ClaudeLoginSession>;
  readonly loggedIn?: boolean;
  readonly logoutCode?: number;
  readonly pty?: PtyAdapter.PtyAdapter["Service"];
}

const harness = (fakes: Fakes = {}) =>
  Effect.gen(function* () {
    const submitted: Array<readonly [string, string]> = [];
    const commands: Array<ReadonlyArray<string>> = [];
    let changed = 0;
    const session: ClaudeLoginSession = {
      authenticate: () =>
        Effect.succeed({ manualUrl, automaticUrl: "http://localhost:1/callback" }),
      submitCode: (code, flowState) => Effect.sync(() => void submitted.push([code, flowState])),
      ...fakes.session,
    };
    const auth = makeClaudeAuth({
      instanceId,
      configDir: "/claude-home",
      openLoginSession: Effect.succeed(session),
      runCommand: (args) =>
        Effect.sync(() => {
          commands.push(args);
          return args[1] === "logout"
            ? { stdout: "", code: fakes.logoutCode ?? 0 }
            : { stdout: JSON.stringify({ loggedIn: fakes.loggedIn ?? true }), code: 0 };
        }),
      terminal: { shell: "claude", cwd: "/", env: {} },
      onChanged: Effect.sync(() => void changed++),
    });
    const controller = yield* fakes.pty
      ? auth.pipe(Effect.provideService(PtyAdapter.PtyAdapter, fakes.pty))
      : auth;
    const phase = (...phases: ReadonlyArray<ProviderAuthState["phase"]>) =>
      controller.subscribe("owner").pipe(
        Stream.filter((current) => phases.includes(current.phase)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    return { controller, phase, submitted, commands, changed: () => changed };
  });

it.effect("signs in with a pasted bare code through the CLI's control requests", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const started = yield* h.controller.start("owner");
    const waiting = yield* h.phase("waiting");
    assert.deepEqual(waiting.interaction, {
      type: "browser",
      id: "claude-oauth",
      url: manualUrl,
      requiresConsent: false,
      acceptsCallback: true,
      callbackInput: "code",
    });
    const flowId = started.flowId!;
    const wrong = yield* h.controller
      .complete("owner", { flowId, callbackUrl: "test-only-code#other" })
      .pipe(Effect.flip);
    assert.notInclude(wrong.detail, "test-only-code");
    yield* h.controller.complete("owner", { flowId, callbackUrl: "test-only-code" });
    const done = yield* h.phase("succeeded", "failed");
    assert.strictEqual(done.phase, "succeeded");
    assert.deepEqual(h.submitted, [["test-only-code", state]]);
    assert.deepEqual(h.commands, [["auth", "status", "--json"]]);
    assert.strictEqual(h.changed(), 1);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("fails when Claude reports no account after the code is accepted", () =>
  Effect.gen(function* () {
    const h = yield* harness({ loggedIn: false });
    const { flowId } = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.controller.complete("owner", { flowId: flowId!, callbackUrl: "test-only-code" });
    const failed = yield* h.phase("failed", "succeeded");
    assert.strictEqual(failed.phase, "failed");
    assert.strictEqual(h.changed(), 0);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("falls back to `auth login` in a terminal when control login is unavailable", () =>
  Effect.gen(function* () {
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let spawned: PtyAdapter.PtySpawnInput | undefined;
    const pty: PtyAdapter.PtyAdapter["Service"] = {
      spawn: (input) =>
        Effect.sync(() => {
          spawned = input;
          return {
            pid: 1,
            write: () => {},
            resize: () => {},
            kill: () => {},
            onData: () => () => {},
            onExit: (callback) => {
              exit = callback;
              return () => {};
            },
          };
        }),
    };
    const h = yield* harness({
      pty,
      session: { authenticate: () => Effect.fail(new ClaudeControlLoginUnavailable()) },
    });
    yield* h.controller.start("owner", undefined, "console");
    const waiting = yield* h.phase("waiting");
    assert.strictEqual(waiting.interaction?.type, "terminal");
    assert.deepEqual(spawned?.args, ["auth", "login", "--console"]);
    exit!({ exitCode: 0, signal: null });
    assert.strictEqual((yield* h.phase("succeeded", "failed")).phase, "succeeded");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("without a PTY, unavailable control login fails with a safe message", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      session: { authenticate: () => Effect.fail(new ClaudeControlLoginUnavailable()) },
    });
    const methods = (yield* h.controller.subscribe("owner").pipe(
      Stream.filter((current) => current.methods !== undefined),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )).methods!;
    assert.deepEqual(
      methods.map((method) => method.id),
      ["claudeai", "console"],
    );
    yield* h.controller.start("owner");
    const failed = yield* h.phase("failed");
    assert.strictEqual(failed.message, "Interactive sign-in is unavailable on this environment.");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("signs out with `auth logout` and reports a refusal", () =>
  Effect.gen(function* () {
    const h = yield* harness({ logoutCode: 1 });
    const failure = yield* h.controller.logout(Effect.void).pipe(Effect.flip);
    assert.strictEqual(failure.detail, "Claude could not sign out.");
    assert.deepEqual(h.commands, [["auth", "logout"]]);
    const ok = yield* harness();
    const signedOut = yield* ok.controller.logout(Effect.void);
    assert.strictEqual(signedOut.message, "Signed out of Claude.");
    assert.strictEqual(ok.changed(), 1);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("treats a CLI without the control request as unavailable and redacts other errors", () =>
  Effect.gen(function* () {
    const missing = makeClaudeQueryLoginSession(instanceId, {});
    assert.strictEqual(
      (yield* missing.authenticate(true).pipe(Effect.flip))._tag,
      "ClaudeControlLoginUnavailable",
    );
    const old = makeClaudeQueryLoginSession(instanceId, {
      claudeAuthenticate: () =>
        Promise.reject(new Error("Unsupported control request subtype: claude_authenticate")),
    });
    assert.strictEqual(
      (yield* old.authenticate(true).pipe(Effect.flip))._tag,
      "ClaudeControlLoginUnavailable",
    );
    const secret = "test-only-0123456789abcdefghijklmnop";
    const leaky = makeClaudeQueryLoginSession(instanceId, {
      claudeOAuthCallback: () =>
        Promise.reject(
          new Error(`Token exchange failed for ${secret} at https://example.com/token?x=1`),
        ),
    });
    const error = yield* leaky.submitCode(secret, state).pipe(Effect.flip);
    assert.notInclude(error.detail, secret);
    assert.notInclude(error.detail, "https://");
    assert.include(error.detail, "Claude did not accept the sign-in code.");
  }),
);

it.effect("returns the manual and automatic sign-in links the CLI issues", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const session = makeClaudeQueryLoginSession(instanceId, {
      claudeAuthenticate: (loginWithClaudeAi: unknown) => {
        calls.push(loginWithClaudeAi);
        return Promise.resolve({ manualUrl, automaticUrl: "http://localhost:1/callback" });
      },
    });
    const urls = yield* session.authenticate(false);
    assert.strictEqual(urls.manualUrl, manualUrl);
    assert.deepEqual(calls, [false]);
  }),
);
