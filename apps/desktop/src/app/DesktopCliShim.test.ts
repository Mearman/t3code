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

const MOUNT = {
  ready: (image: string) => `echo '${image}'`,
  fails: () => 'echo "Cannot mount AppImage"; exit 1',
  pending: () => "echo pending >&3",
};

const fakeAppImage = (mount: keyof typeof MOUNT = "ready", app = REPORTER) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), app);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      'if [ "$1" = --appimage-extract ]; then',
      `  echo extracting 2>/dev/null >&3; cp -R '${image}' squashfs-root; exit 0`,
      "fi",
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      `echo $$ >'${root}/mounter.pid'`,
      // Like the FUSE runtime, any of these unmounts. fd 3 reports to the test when it is open.
      "trap 'echo unmounted >&3 2>/dev/null; exit 0' TERM HUP INT",
      "trap 'echo mounted >&3 2>/dev/null' WINCH",
      // After the traps: the launcher, and so the test's signals, can follow at once.
      MOUNT[mount](image),
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

const editLauncher = (shim: string, edit: (script: string) => string) => {
  const script = NodeFS.readFileSync(shim, "utf8");
  const edited = edit(script);
  expect(edited).not.toBe(script);
  NodeFS.writeFileSync(shim, edited);
};

// A named pipe the test holds both ends of, so neither side blocks if the other is gone. A script
// reading a line from it waits until the test writes one.
const makeGate = (root: string, name = "gate") => {
  const path = NodePath.join(root, name);
  expect(NodeChildProcess.spawnSync("mkfifo", [path]).status).toBe(0);
  return { fd: NodeFS.openSync(path, "r+"), wait: `head -n 1 '${path}' >/dev/null` };
};

// Edits the launcher to stop at a chosen place until a line is written to the returned pipe.
const holdLauncher = (
  { root, shim }: { readonly root: string; readonly shim: string },
  edit: Edit,
) => {
  const gate = makeGate(root);
  editLauncher(shim, (script) => edit(script, `echo held >&3; ${gate.wait}`));
  return gate.fd;
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

const STOP_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
// The launcher runs under whichever shell is `/bin/sh`: dash on Debian, bash on others.
const SHELLS = ["sh", "bash"] as const;

const EARLY_STOPS = STOP_SIGNALS.flatMap((signal) =>
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
    readonly errors: ReturnType<typeof lines>;
    readonly exited: Promise<number | null>;
    readonly closed: Promise<number | null>;
    readonly mounter: () => number;
  }) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
) => {
  const child = NodeChildProcess.spawn(shim, [], {
    detached: true,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const mounter = () => Number(NodeFS.readFileSync(NodePath.join(root, "mounter.pid"), "utf8"));
  try {
    await use({
      child,
      stdout: lines(child.stdout!),
      events: lines(child.stdio[3] as NodeJS.ReadableStream),
      errors: lines(child.stderr!),
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
      const fake = fakeAppImage("ready", SLOW_SERVER);
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
      const fake = fakeAppImage("ready", "#!/bin/sh\necho started >&3\nexit 3\n");
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

  // A stop to the process group also kills the step the launcher is waiting for, so it fails.
  it.skipIf(!hasSetsid).each(
    STOP_SIGNALS.flatMap((signal) =>
      [
        { step: "creating its work directory", command: "mktemp -d" },
        { step: "extracting the image", command: '"$app" --appimage-extract >/dev/null' },
      ].map((failing) => ({ signal, ...failing })),
    ),
  )("exits as stopped after $signal while $step fails", async ({ signal, command }) => {
    const fake = fakeAppImage("fails");
    const gate = holdLauncher(fake, (script, hold) =>
      script.replace(command, () => `{ ${hold}; false; }`),
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
  });

  it.skipIf(!hasSetsid).each(STOP_SIGNALS)(
    "exits without extracting after %s while the mount is pending",
    async (signal) => {
      const fake = fakeAppImage("pending");
      await withLauncher(fake, async ({ child, events, closed }) => {
        await events.until((line) => line === "pending");
        process.kill(child.pid!, signal);
        expect(await closed).toBe(130);
        expect(events.seen).toEqual(["pending", "unmounted"]);
      });
    },
  );

  it.skipIf(!hasSetsid).each(STOP_SIGNALS)(
    "waits for a mounter that has not reset the launcher's traps before stopping it after %s",
    async (signal) => {
      const fake = fakeAppImage();
      const gate = holdLauncher(fake, (script, hold) =>
        script
          // Reports that the launcher is still waiting although it has noted the stop.
          .replace(
            'while [ ! -e "$1" ]',
            () => 'while { [ -z "$stop" ] || echo waiting >&3; }; [ ! -e "$1" ]',
          )
          .replace(MOUNTER_LINE, (line) => line.replace("{ ", () => `{ ${hold}; `)),
      );
      try {
        await withLauncher(fake, async ({ child, events, exited, closed }) => {
          await events.until((line) => line === "held");
          process.kill(child.pid!, signal);
          const first = await Promise.race([events.until((line) => line === "waiting"), exited]);
          expect(first).toBe("waiting");
          NodeFS.writeSync(gate, "\n");
          expect(await closed).toBe(130);
        });
      } finally {
        NodeFS.closeSync(gate);
      }
    },
  );

  it.skipIf(!hasSetsid)("reads the mount path only once the mounter's output exists", async () => {
    const fake = fakeAppImage();
    const gate = holdLauncher(fake, (script, hold) =>
      script
        .replace("exec setsid", () => `${hold}; exec setsid`)
        .replace('mount=$(head -n 1 "$work/mount")', (read) => `${read}; echo polled >&3`),
    );
    try {
      await withLauncher(fake, async ({ events, errors, closed }) => {
        await events.until((line) => line === "held");
        await events.until((line) => line === "polled");
        NodeFS.writeSync(gate, "\n");
        expect(await closed).toBe(3);
        expect(errors.seen).toEqual([]);
      });
    } finally {
      NodeFS.closeSync(gate);
    }
  });

  // A trapped signal ends `wait` early, and the server can exit before the launcher looks again.
  it.skipIf(!hasSetsid).each(SHELLS)(
    "exits with the server's status when an interrupted wait finds it gone, under %s",
    async (shell) => {
      const fake = fakeAppImage("ready", "#!/bin/sh\nexit 7\n");
      editLauncher(fake.shim, (script) =>
        script
          .replace("#!/bin/sh", `#!/usr/bin/env ${shell}`)
          // Stands in for the interrupted wait: the server is reaped, its status not yet read.
          .replace(
            /^wait "\$cli" \|\| status=\$\?$/m,
            () => 'while kill -0 "$cli" 2>/dev/null; do sleep 0.01; done; status=130',
          ),
      );
      await withLauncher(fake, async ({ closed }) => {
        expect(await closed).toBe(7);
      });
    },
  );

  it.skipIf(!hasSetsid).each(SHELLS)(
    "exits with the server's status after Ctrl-C and TERM while it starts, under %s",
    async (shell) => {
      const fake = fakeAppImage("ready", SLOW_SERVER);
      const server = makeGate(fake.root, "server-gate");
      const sender = NodePath.join(fake.root, "send-stops");
      // TERM follows once the launcher is asleep again, having taken the Ctrl-C or blocked it.
      writeExecutable(
        sender,
        [
          "#!/bin/sh",
          'state="/proc/$1/status"',
          // Bit 1 of a signal mask, the last hex digit, is INT.
          'int() { grep -q "^$1:.*[2367abef]\\$" "$state"; }',
          'kill -INT "$1"',
          'until grep -q "^State:.S" "$state" && { ! int ShdPnd || int SigBlk; }; do :; done',
          'kill -TERM "$1"',
          "",
        ].join("\n"),
      );
      // Holds the server's process before it reports in, and sends both stops from inside the
      // launcher's next sleep, which is then held too.
      const gate = holdLauncher(fake, (script, hold) =>
        script
          .replace("#!/bin/sh", `#!/usr/bin/env ${shell}`)
          .replace(': >"$work/cli-started"', (report) => `${server.wait}; ${report}`)
          .replace(
            'await_start "$work/cli-started"',
            (wait) => `sleep() { '${sender}' $$; ${hold}; }\n${wait}`,
          ),
      );
      try {
        await withLauncher(fake, async ({ child, stdout, events, closed }) => {
          await events.until((line) => line === "held");
          NodeFS.writeSync(server.fd, "\n");
          await stdout.until((line) => line === "ready");
          NodeFS.writeSync(gate, "\n");
          await events.until((line) => line === "stopping");
          child.stdin!.end("go\n");
          expect(await closed).toBe(7);
        });
      } finally {
        NodeFS.closeSync(gate);
        NodeFS.closeSync(server.fd);
      }
    },
  );

  it.skipIf(!hasSetsid).each(
    STOP_SIGNALS.flatMap((signal) => [
      { signal, when: "the server exits", early: false, status: 3 },
      { signal, when: "a stop during startup", early: true, status: 130 },
    ]),
  )(
    "removes the extracted image after $when although $signal arrives during the removal",
    async ({ signal, early, status }) => {
      const fake = fakeAppImage("fails");
      const temporary = NodePath.join(fake.root, "tmp");
      NodeFS.mkdirSync(temporary);
      const shims = NodePath.join(fake.root, "shims");
      const removal = makeGate(fake.root, "removal-gate");
      // Holds `rm` with whatever signal handling it inherited from the launcher.
      writeExecutable(
        NodePath.join(shims, "rm"),
        `#!/bin/sh\necho removing >&3\n${removal.wait}\nPATH='${process.env.PATH}' exec rm "$@"\n`,
      );
      const extraction = early
        ? holdLauncher(fake, (script, hold) =>
            script.replace(
              '"$app" --appimage-extract >/dev/null',
              (extract) => `{ ${extract}; ${hold}; }`,
            ),
          )
        : undefined;
      try {
        await withLauncher(
          fake,
          async ({ child, events, closed }) => {
            if (extraction !== undefined) {
              await events.until((line) => line === "held");
              process.kill(child.pid!, signal);
              NodeFS.writeSync(extraction, "\n");
            }
            await events.until((line) => line === "removing");
            process.kill(-child.pid!, signal);
            NodeFS.writeSync(removal.fd, "\n");
            expect(await closed).toBe(status);
            expect(NodeFS.readdirSync(temporary)).toEqual([]);
          },
          { PATH: `${shims}:${process.env.PATH}`, TMPDIR: temporary },
        );
      } finally {
        if (extraction !== undefined) NodeFS.closeSync(extraction);
        NodeFS.closeSync(removal.fd);
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
      const fake = fakeAppImage("ready", "#!/bin/sh\nread go\nexit 5\n");
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
    const { shim } = fakeAppImage("fails");
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
