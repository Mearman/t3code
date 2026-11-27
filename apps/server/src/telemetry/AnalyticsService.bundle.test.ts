import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { afterEach, vi } from "vite-plus/test";

// A bundle reads its build kind and collector from compile-time defines, so each case loads a
// fresh module graph under stubbed defines and uses that graph's own `AnalyticsService.layer`.
const requestsFromBundle = (
  defines: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    vi.resetModules();
    for (const [name, value] of Object.entries(defines)) vi.stubGlobal(name, value);
    const [Analytics, ServerConfig, HostProcess, ManagedPolicy] = yield* Effect.promise(() =>
      Promise.all([
        import("./AnalyticsService.ts"),
        import("../config.ts"),
        import("@t3tools/shared/HostProcess"),
        import("../policy/ManagedPolicy.ts"),
      ]),
    );
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })));
    });
    const layer = Analytics.layer.pipe(
      Layer.provideMerge(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-bundle-" })),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
          Layer.succeed(HttpClient.HttpClient, client),
          ManagedPolicy.layerTest(undefined),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const analytics = yield* Analytics.AnalyticsService;
      for (let index = 0; index < 20; index += 1) yield* analytics.record("test.bundle", { index });
      for (let second = 0; second < 60; second += 1) yield* TestClock.adjust("1 second");
    }).pipe(Effect.provide(layer));
    return [...new Set(urls)];
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("usage data by bundle", (it) => {
  const enabled = { T3CODE_TELEMETRY_ENABLED: true };

  it.effect("sends nothing from a bundle with no build-kind define, even when enabled", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* requestsFromBundle({}, enabled), []);
    }),
  );

  it.effect("sends nothing from a bundle defined as not upstream's and naming no collector", () =>
    Effect.gen(function* () {
      const defines = { __T3CODE_BUILD_PROVABLY_UPSTREAM__: false };
      assert.deepEqual(yield* requestsFromBundle(defines, enabled), []);
    }),
  );

  it.effect("sends a bundle defined as upstream's to T3's collector", () =>
    Effect.gen(function* () {
      const defines = { __T3CODE_BUILD_PROVABLY_UPSTREAM__: true };
      assert.deepEqual(yield* requestsFromBundle(defines, enabled), [
        "https://ingest.t3.codes/batch/",
      ]);
    }),
  );

  it.effect("sends a bundle's events to the collector baked into it, never to T3's", () =>
    Effect.gen(function* () {
      const defines = {
        __T3CODE_BUILD_PROVABLY_UPSTREAM__: false,
        __T3CODE_BUILD_TELEMETRY_KEY__: "phc_baked",
        __T3CODE_BUILD_TELEMETRY_HOST__: "https://baked.example.com",
      };
      assert.deepEqual(yield* requestsFromBundle(defines, enabled), [
        "https://baked.example.com/batch/",
      ]);
    }),
  );
});
