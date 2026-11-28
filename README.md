<p align="center">
  <img src="./assets/mearcode/mearcode-web-icon-192x192.png" width="80" height="80" alt="MearCode logo" />
</p>

<h1 align="center">MearCode</h1>

<p align="center">An unofficial fork based on the T3 Code source code. It is not affiliated with, endorsed by or maintained by T3 Tools, Inc.</p>

<p align="center">
  <a href="https://github.com/Mearman/t3code/releases"><strong>Releases</strong></a> ·
  <a href="./docs/README.md">Docs</a>
</p>

MearCode runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from another device.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, MearCode can control it.

## What you get

- **Your subscriptions.** MearCode does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop and web.** One server, and every client shows the same threads.
- **Remote ready.** Run agents on any machine and connect over your local network or Tailscale.
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Open.** Source code is MIT licensed (see [Trademarks and forks](#trademarks-and-forks)).

## Install

Every MearCode release is on [GitHub Releases](https://github.com/Mearman/t3code/releases).

### Desktop app

- **macOS:** the `MearCode-*.dmg` or `.zip` for your Mac's architecture. Builds are signed with a self-signed certificate, so macOS asks you to approve the first launch.
- **Linux:** the `MearCode-*.AppImage` (`chmod +x` it, then run it) or the `MearCode-*.deb`, for x86_64 or ARM64.

### Command line

Each release carries an `install.sh` that installs the `t3` command from that repository's releases. Run `sh install.sh` after downloading it, then run `t3` to start the server and open the web app.

### Sign in to an agent

MearCode needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list. Some pages were written for T3 Code and still use its name.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request. Build from source with the [development runbook](./docs/operations/00_development.md#first-checkout). The [architecture overview](./docs/internals/01_architecture.md) explains how it works.

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Trademarks and forks

MearCode is derived from [T3 Code](https://github.com/pingdotgg/t3code) and is not the official T3 Code. It uses its own name and icons, and uses no T3 logos or wordmarks.

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons. See [TRADEMARK.md](./TRADEMARK.md) for the full trademark and branding policy.
