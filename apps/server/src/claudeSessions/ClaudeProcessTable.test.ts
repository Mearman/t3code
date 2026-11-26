import { describe, expect, it } from "@effect/vitest";

import {
  claudeProcessTableCommand,
  parseClaudeProcessTable,
  parseWindowsClaudeProcessTable,
} from "./ClaudeProcessTable.ts";

describe("claudeProcessTableCommand", () => {
  it("lists processes with ps, in the form procStart is written in, outside Windows", () => {
    const { parse, ...command } = claudeProcessTableCommand("linux");
    expect(command).toEqual({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC0" },
    });
    expect(parse).toBe(parseClaudeProcessTable);
  });

  it("lists processes with their parents and creation times through CIM on Windows", () => {
    const { parse, command, args } = claudeProcessTableCommand("win32");
    expect(command).toBe("powershell.exe");
    expect(args.at(-1)).toContain("Win32_Process");
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
