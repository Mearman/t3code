import { describe, expect, it } from "@effect/vitest";

import {
  claudeDescendants,
  claudeProcessTableCommand,
  indexClaudeProcessTable,
  parseClaudeProcessTable,
  parseWindowsClaudeProcessTable,
} from "./ClaudeProcessTable.ts";

describe("claudeProcessTableCommand", () => {
  it("lists processes with ps, in the form procStart is written in, outside Windows", () => {
    const { parse, ...command } = claudeProcessTableCommand("linux", {});
    expect(command).toEqual({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC0" },
    });
    expect(parse).toBe(parseClaudeProcessTable);
  });

  it("runs Windows PowerShell by absolute path and skips processes with no creation time", () => {
    const { parse, command, args } = claudeProcessTableCommand("win32", { SystemRoot: "D:\\Win" });
    expect(command).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.at(-1)).toContain("Get-CimInstance Win32_Process");
    expect(args.at(-1)).toContain("Where-Object { $_.CreationDate }");
    expect(parse).toBe(parseWindowsClaudeProcessTable);
  });
});

describe("parseWindowsClaudeProcessTable", () => {
  it("reads pid, parent and creation time, each process its own group", () => {
    expect(parseWindowsClaudeProcessTable("4 0 1767225600\r\n812 4 1767225660\r\n\r\nbad")).toEqual(
      [
        { pid: 4, ppid: 0, pgid: 4, startTimeSeconds: 1767225600 },
        { pid: 812, ppid: 4, pgid: 812, startTimeSeconds: 1767225660 },
      ],
    );
  });
});

describe("claudeDescendants", () => {
  it("leaves out a process started before its recorded parent, which Windows never reparents", () => {
    const table = indexClaudeProcessTable(
      parseWindowsClaudeProcessTable("10 1 200\n11 10 300\n12 10 100"),
    );
    expect(claudeDescendants(table, [10]).map((row) => row.pid)).toEqual([11]);
  });
});
