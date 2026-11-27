import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  environmentReleaseCheckAtom,
  environmentReleaseSource,
  releaseCheckError,
} from "./environmentUpdateCheck";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { releaseRepository: "owner/fork" } } },
}));

function stubHangingFetch() {
  const { promise: called, resolve } = Promise.withResolvers<AbortSignal>();
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
    urls.push(url);
    resolve(init.signal);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  });
  return { called, urls, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const server = (releaseRepository?: string) => async () => ({
  serverVersion: "0.0.40",
  releaseRepository,
});

function makeRegistry() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => undefined;
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  return { registry, flush };
}

describe("environmentReleaseSource", () => {
  it("reads the server's version and the release repository it reports", () => {
    expect(
      environmentReleaseSource({
        serverVersion: "0.0.40",
        capabilities: { repositoryIdentity: true, serverReleaseRepository: "owner/fork" },
      }),
    ).toEqual({ serverVersion: "0.0.40", releaseRepository: "owner/fork" });
    const descriptor = { serverVersion: "0.0.40", capabilities: { repositoryIdentity: true } };
    expect(environmentReleaseSource(descriptor)).toEqual({
      serverVersion: "0.0.40",
      releaseRepository: undefined,
    });
  });
});

describe("environmentReleaseCheckAtom", () => {
  it("aborts the release lookup when the screen stops reading it", async () => {
    using fetchStub = stubHangingFetch();
    const { registry, flush } = makeRegistry();
    const atom = environmentReleaseCheckAtom(EnvironmentId.make("env-unmount"));
    const unmount = registry.mount(atom);

    registry.set(atom, server());
    const signal = await fetchStub.called;
    expect(signal.aborted).toBe(false);
    expect(fetchStub.urls).toEqual(["https://github.com/owner/fork/releases/latest"]);

    unmount();
    flush();
    expect(signal.aborted).toBe(true);
  });

  it("checks against the repository the server reports over the app's own", async () => {
    using fetchStub = stubHangingFetch();
    const { registry, flush } = makeRegistry();
    const atom = environmentReleaseCheckAtom(EnvironmentId.make("env-reported"));
    const unmount = registry.mount(atom);

    registry.set(atom, server("other/server-fork"));
    await fetchStub.called;
    expect(fetchStub.urls).toEqual(["https://github.com/other/server-fork/releases/latest"]);

    unmount();
    flush();
  });

  it("reports a timeout in words after 20 seconds", async () => {
    using fetchStub = stubHangingFetch();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const { registry, flush } = makeRegistry();
    const atom = environmentReleaseCheckAtom(EnvironmentId.make("env-timeout"));
    const unmount = registry.mount(atom);

    registry.set(atom, server());
    const signal = await fetchStub.called;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal.aborted).toBe(true);
    expect(releaseCheckError(registry.get(atom))).toBe(
      "Checking for updates timed out. Try again.",
    );
    unmount();
    flush();
  });
});
