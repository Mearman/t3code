// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { type CliShimTarget, renderCliShim } from "./DesktopCliShim.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
  directories.push(root);
  return root;
};

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "t3");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH home=$T3CODE_HOME appimage=$APPIMAGE"\nprintf "%s\\n" "$@"\nexit 3\n';

const fakeAppImage = (canMount = true, app = REPORTER) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), app);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      `echo $$ >'${root}/mounter.pid'`,
      // Like the FUSE runtime, any of these unmounts. fd 3 reports to the test when it is open.
      "trap 'echo unmounted >&3 2>/dev/null; exit 0' TERM HUP INT",
      "trap 'echo mounted >&3 2>/dev/null' WINCH",
      // After the traps: the launcher, and so the test's signals, can follow at once.
      canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3code" });
  return { root, image, appImage, shim };
};

// Stays up after a signal until the test lets it finish, like a server shutting down. A group
// signal and the launcher's forwarded one can both arrive; a re-run trap would read stdin's EOF.
const SLOW_SERVER = [
  "#!/bin/sh",
  'trap \'trap "" TERM HUP; echo stopping >&3; read go; echo "stopped $go" >&3; exit 7\' TERM HUP',
  "echo ready",
  "while :; do sleep 0.05; done",
  "",
].join("\n");

// The launcher mounts only under setsid, which stock macOS and Windows lack; there it extracts instead.
const hasSetsid = NodeChildProcess.spawnSync("setsid", ["true"]).status === 0;

// The launcher's lines that start the mounter and, in the background, the server.
const MOUNTER_LINE = /^.*setsid .*--appimage-mount.*&$/m;
const SERVER_LINE = /^(.*) <&9 9<&- &$/m;

type Edit = (script: string, hold: string) => string;

// Edits the launcher to stop at a chosen place until a line is written to the returned pipe. The
// test holds both ends of the pipe, so neither side blocks if the other is gone.
const holdLauncher = (
  { root, shim }: { readonly root: string; readonly shim: string },
  edit: Edit,
) => {
  const gate = NodePath.join(root, "gate");
  expect(NodeChildProcess.spawnSync("mkfifo", [gate]).status).toBe(0);
  const script = NodeFS.readFileSync(shim, "utf8");
  const held = edit(script, `echo held >&3; head -n 1 '${gate}' >/dev/null`);
  expect(held).not.toBe(script);
  NodeFS.writeFileSync(shim, held);
  return NodeFS.openSync(gate, "r+");
};

const HOLDS: Record<string, Edit> = {
  // Waits for the mount path first, so the mounter is up and able to report that it unmounted.
  "right after it starts the mounter": (script, hold) =>
    script.replace(
      MOUNTER_LINE,
      (line) => `${line}\nuntil [ -s "$work/mount" ]; do sleep 0.01; done; ${hold}`,
    ),
  // Ahead of the launcher's last check for a stop, where it has one.
  "right before it starts the server": (script, hold) =>
    script.replace(
      /^(?:\[ -z "\$stop" \] \|\| exit 130\n)?(?=.* <&9 9<&- &$)/m,
      (check) => `${hold}\n${check}`,
    ),
};

const EARLY_STOPS = (["SIGHUP", "SIGINT", "SIGTERM"] as const).flatMap((signal) =>
  Object.entries(HOLDS).map(([place, edit]): [NodeJS.Signals, string, Edit] => [
    signal,
    place,
    edit,
  ]),
);

const lines = (stream: NodeJS.ReadableStream) => {
  const seen: Array<string> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    seen.push(...parts);
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (match: (line: string) => boolean) => {
    for (;;) {
      const line = seen.find(match);
      if (line !== undefined) return line;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { seen, until };
};

// Runs the launcher in its own process group and kills whatever is left of it afterwards.
const withLauncher = async (
  { root, shim }: { readonly root: string; readonly shim: string },
  use: (launcher: {
    readonly child: NodeChildProcess.ChildProcess;
    readonly stdout: ReturnType<typeof lines>;
    readonly events: ReturnType<typeof lines>;
    readonly exited: Promise<number | null>;
    readonly closed: Promise<number | null>;
    readonly mounter: () => number;
  }) => Promise<void>,
) => {
  const child = NodeChildProcess.spawn(shim, [], {
    detached: true,
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  const mounter = () => Number(NodeFS.readFileSync(NodePath.join(root, "mounter.pid"), "utf8"));
  try {
    await use({
      child,
      stdout: lines(child.stdout!),
      events: lines(child.stdio[3] as NodeJS.ReadableStream),
      exited: new Promise((resolve) => child.on("exit", resolve)),
      // Also waits for everything that inherited the pipes, the mounter included.
      closed: new Promise((resolve) => child.on("close", resolve)),
      mounter,
    });
  } finally {
    for (const find of [() => -child.pid!, mounter]) {
      try {
        const pid = find();
        // Zero would signal the test's own process group.
        if (pid !== 0) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
};

describe("renderCliShim", () => {
  // Ctrl-C, an SSH hangup, or a supervisor signals the process group. systemd's default KillMode
  // also signals the mounter, and KillMode=mixed signals only the launcher.
  it.skipIf(!hasSetsid).each([
    ["SIGTERM", "the process group"],
    ["SIGHUP", "the process group"],
    ["SIGTERM", "every process"],
    ["SIGTERM", "the launcher"],
    ["SIGTERM", "a launcher still starting the server"],
    ["SIGHUP", "a launcher still starting the server"],
    ["SIGINT", "a launcher still starting the server"],
  ] as const)(
    "keeps the AppImage mounted until the server exits after %s to %s",
    async (signal, target) => {
      const fake = fakeAppImage(true, SLOW_SERVER);
      const gate =
        target === "a launcher still starting the server"
          ? holdLauncher(fake, (script, hold) =>
              script.replace(SERVER_LINE, (line) => `${line}\n${hold}`),
            )
          : undefined;
      try {
        await withLauncher(fake, async ({ child, stdout, events, closed, mounter }) => {
          await stdout.until((line) => line === "ready");

          const grouped = target === "the process group" || target === "every process";
          process.kill(grouped ? -child.pid! : child.pid!, signal);
          if (target === "every process") process.kill(mounter(), signal);
          if (gate !== undefined) {
            NodeFS.writeSync(gate, "\n");
            // A launcher that exits here unmounts, and the server never hears of the stop.
            const first = await events.until((line) => line === "stopping" || line === "unmounted");
            expect(first).toBe("stopping");
          }
          // The shell runs pending traps in ascending signal number, and WINCH outnumbers TERM and
          // HUP, so a mounter that also got the group signal unmounts before it answers this probe.
          process.kill(mounter(), "SIGWINCH");
          const mount = await events.until((line) => line === "mounted" || line === "unmounted");
          expect(mount).toBe("mounted");

          await events.until((line) => line === "stopping");
          child.stdin!.end("go\n");
          expect(await closed).toBe(7);
          expect(events.seen.slice(-2)).toEqual(["stopped go", "unmounted"]);
        });
      } finally {
        if (gate !== undefined) NodeFS.closeSync(gate);
      }
    },
  );

  it.skipIf(!hasSetsid).each(EARLY_STOPS)(
    "unmounts without starting the server after %s %s",
    async (signal, _place, edit) => {
      const fake = fakeAppImage(true, "#!/bin/sh\necho started >&3\nexit 3\n");
      const gate = holdLauncher(fake, edit);
      try {
        await withLauncher(fake, async ({ child, events, exited, closed }) => {
          await events.until((line) => line === "held");
          process.kill(child.pid!, signal);
          NodeFS.writeSync(gate, "\n");
          // Not `closed`: a mounter left running would keep the pipes open.
          expect(await exited).toBe(130);
          await closed;
          expect(events.seen).toEqual(["held", "unmounted"]);
        });
      } finally {
        NodeFS.closeSync(gate);
      }
    },
  );

  it.skipIf(!hasSetsid).each(["SIGHUP", "SIGINT", "SIGTERM"] as const)(
    "exits as stopped, not as a broken image, after %s during extraction",
    async (signal) => {
      const fake = fakeAppImage(false);
      // A stop to the process group also kills the extraction, so the held one fails.
      const gate = holdLauncher(fake, (script, hold) =>
        script.replace('"$app" --appimage-extract >/dev/null', `{ ${hold}; false; }`),
      );
      try {
        await withLauncher(fake, async ({ child, events, closed }) => {
          await events.until((line) => line === "held");
          process.kill(child.pid!, signal);
          NodeFS.writeSync(gate, "\n");
          expect(await closed).toBe(130);
        });
      } finally {
        NodeFS.closeSync(gate);
      }
    },
  );

  // dash drops a signal that reaches a new background process before it has reset the traps it
  // was forked with. The hold stands in for that moment: a signal sent into it is only reported.
  it.skipIf(!hasSetsid).each([
    ["SIGHUP", 129],
    ["SIGINT", 143],
    ["SIGTERM", 143],
  ] as const)(
    "stops a server that has not reset the launcher's traps when %s arrives",
    async (signal, status) => {
      const fake = fakeAppImage(true, "#!/bin/sh\nread go\nexit 5\n");
      const gate = holdLauncher(fake, (script, hold) =>
        script
          .replace(/^trap '(.+)' (TERM|HUP|INT)$/gm, "trap '$1; echo trapped >&3' $2")
          .replace(
            SERVER_LINE,
            (_line, server: string) =>
              `{ trap 'echo deaf >&3' TERM HUP; ${hold}; trap - TERM HUP; ${server}; } <&9 9<&- &`,
          ),
      );
      try {
        await withLauncher(fake, async ({ child, events, closed }) => {
          await events.until((line) => line === "held");
          process.kill(child.pid!, signal);
          await events.until((line) => line === "trapped");
          NodeFS.writeSync(gate, "\n");
          const outcome = await Promise.race([events.until((line) => line === "deaf"), closed]);
          expect(outcome).toBe(status);
          expect(events.seen.at(-1)).toBe("unmounted");
        });
      } finally {
        NodeFS.closeSync(gate);
      }
    },
  );

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });

  // The server skips its compile cache only under APPIMAGE; each mount path is new.
  it("tells the CLI it runs from the mounted AppImage", () => {
    const { appImage, shim } = fakeAppImage();
    const result = run(shim, ["--version"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`appimage=${appImage}`);
    const closedStdin = NodeChildProcess.spawnSync("sh", ["-c", '"$0" --version <&-', shim]);
    expect(closedStdin.status).toBe(3);
  });

  it("keeps the install's T3 home under sudo, unless one is set", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3CODE_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    const relative = NodeChildProcess.spawnSync("./bin/t3", [], { cwd: root, encoding: "utf8" });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.t3\\bin\\t3.cmd",
      t3Home: "C:\\Users\\José\\.t3",
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(lines).toContain("chcp 65001 >nul");
    expect(lines).toContain(
      'if exist "C:\\Apps\\R&whoami&X 100%%\\!CHANNEL!\\T3 Code.exe" goto run',
    );
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\t3.cmd"');
  });
});
