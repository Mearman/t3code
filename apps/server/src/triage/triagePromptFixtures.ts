import type { TriageContextInput } from "./triagePrompt.ts";

export const contextInput = {
  generatedAt: "2026-09-24T00:00:00.000Z",
  os: "linux x64 (7.2.0)",
  nodeVersion: "v26.8.2",
  paths: {
    stateDir: "/home/u/.t3/userdata",
    dbPath: "/home/u/.t3/userdata/state.sqlite",
    settingsPath: "/home/u/.t3/userdata/settings.json",
    logsDir: "/home/u/.t3/userdata/logs",
    serviceLogPath: "/home/u/.t3/userdata/logs/boot-service.log",
    desktopBackendLogGlob: "/home/u/.t3/userdata/logs/server-child*.log*",
    relayClientLogPath: "/home/u/.t3/userdata/logs/relay-client.ndjson",
    serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
    providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
    terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
    providerStatusCacheDir: "/home/u/.t3/caches",
    secretsDir: "/home/u/.t3/userdata/secrets",
    sourceCacheDir: "/home/u/.t3/source",
  },
} satisfies Omit<TriageContextInput, "entry" | "server">;
