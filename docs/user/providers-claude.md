# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Sign in

**Settings → Providers → Claude → Sign in** (or **Providers** on mobile) signs Claude Code in on the environment's machine, so it works from a phone or another computer. Open the sign-in page, sign in, then paste the code the page shows. **Anthropic Console** signs in for API billing instead of a subscription. If the installed Claude Code cannot sign in this way, T3 Code runs `claude auth login` in a terminal instead. **Sign out** runs `claude auth logout` for that instance's config directory.

## Multiple accounts and presets

**Add Claude account** (in **Settings → Providers → Add provider → Claude**, or **Providers** on mobile) creates a new account with its own config folder on the environment's machine, then signs it in. By default it shares projects, sessions, file history and tasks with an existing Claude account, so `claude --resume` finds the same sessions from either account; choose **Keep history separate** to give it its own.

Each thread remembers the account it sends as, read from the Claude process that sends it. If Claude is later signed in as a different account (on that instance, or after switching the thread to another one), nothing is sent until you choose **Send as this account** on the refused turn, which names both accounts; this needs an up-to-date app. Confirming does not resend what was refused, including a scheduled task's or a delegated thread's message, so send it again. A Claude process that names no account counts as a different account on a thread that already has one. Accounts without an email, such as API keys, are told apart only by where their credential comes from, so a switch between two keys from the same source is not caught.

To use a config folder you already have, such as `~/.claude_personal`, add a Claude instance and point **CLAUDE_CONFIG_DIR path** at it (leave empty for the default directory), then sign in to it as above. Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- A thread switches natively between Claude accounts that share history; to send a thread to an account with separate history, move it as below.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Move threads between accounts

**Move to another Claude account…** in a thread's menu, or **Move threads** on a Claude account in **Settings → Providers** (or the account's menu on mobile), sends the history to another Claude account, which then continues the thread. The confirmation names both accounts.

- **Compact first** is on by default (**Settings → Threads → Compact before moving to another account**) and can be skipped for one move. It runs under the old account, so the new account starts from a summary; the full history stays in the session. If the old account cannot compact (signed out, out of usage), nothing moves until you choose to move without compacting.
- Between accounts that share history, the thread simply continues on the new account. Otherwise its session files are copied into the new account's folder, checked byte for byte, and the originals become links to the copies, so `claude --resume` works from either folder. Nothing changes if a copy fails its check.
- A thread that is working, or open in a terminal, stays where it is. Close the terminal, or take the session over, then move it.
- Moves only happen when you ask: T3 Code never rotates accounts by itself.
- Before any file moves, T3 Code stops its own Claude process for the thread and holds new messages to it until the thread is on the new account; a message sent meanwhile waits, then goes to the new account, and anything else that would start or fork a turn meanwhile is refused with a note to try again once the move has finished. A workspace setup that failed before the move cannot be retried on the new account: send the message again. If that process has not exited, or a turn is starting, the thread stays where it is and you can try again. A thread whose account changes while a move waits is left where it is.
- If a step fails, the files are put back and the thread stays on its old account. If putting them back fails too, the move says so; check both Claude folders before resuming the session.
- On Windows a thread moves only between accounts that share history: moving it to an account with its own history needs symbolic links, which Windows allows only with administrator rights or Developer Mode.
- A move of every thread on an account moves them one at a time and shows how many have finished.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Sessions from your terminal

Every Claude Code session in your Claude homes shows up as a thread, in the project of the folder it ran in. A session a terminal is running is followed as it goes; an older one shows its history when you open it, with a "Loading this session's history" note in the thread until it has loaded. A thread whose latest activity came from a terminal carries a **Terminal** badge in the thread list and in the thread's header on the web, and in the list on mobile. A session a terminal still holds refuses a message sent from T3 Code and offers to fork it into a new session, unless that terminal's `claude` runs the T3 bridge mod: then T3 Code hands the message to it (**Hand to the terminal**), Claude writes it as that session's own turn, and the reply follows in the thread. If the terminal does not take it (it was released, started another conversation, or did not answer within two minutes) the thread says so. Handing a message to a terminal needs a connection allowed to use terminals, and a slash command cannot be handed over: type it in that terminal, or fork. Install the mod with `t3 claude bridge install` (add `--home` for a Claude home other than `~/.claude`; Claude Code 2.1.287 or later), then run `/reload-plugins` in a `claude` that is already running; remove it with `t3 claude bridge uninstall`. `/t3-bridge release` in that terminal stops T3 Code sending to it and `/t3-bridge resume` lets it again. A message you wrote (typed, or your answer to a question Claude asked) and then hand over with **Hand to the terminal** arrives as if you typed it there. Everything else arrives marked as the mod's: a message handed over by default or by the setting, one an agent edited while it was queued, an agent's answer to a question, and a scheduled task's message, even from a task you made. Agents and scheduled tasks never hand a message to a terminal themselves. Otherwise set **Sending to an open session** to **Continue in a fork** and T3 Code forks the conversation and sends your message there itself (a message with attachments is carried into the fork for you to send again). **Take over when idle** stops the terminal's `claude` once it is waiting for a prompt (never mid-turn; until then the message waits) and sends from T3 Code, and the refused message offers the same for one send. It stops only a `claude` started from a terminal, and needs a connection allowed to use terminals; otherwise the message is refused as **Ask each time** would. **Send anyway** sends while the terminal waits for a prompt, writing beside it: the session then branches, since the terminal's next prompt continues from before T3 Code's reply, and `claude --resume` follows one side. T3 Code says so under the reply. Like taking over, it writes only beside a `claude` started from a terminal and needs a connection allowed to use terminals. `t3 thread send --held-session fork` forks for one message from the command line; the command line and agents can only ask or fork, never hand a message to a terminal, take over or send beside one. Send to a session no terminal holds and T3 Code continues that same session, so `claude --resume <id>` in the terminal picks up where it left off (with `CLAUDE_CONFIG_DIR` set for a home other than `~/.claude`). Turn it off, add further Claude homes, exclude folders or restore a session whose thread you deleted under **Settings → Threads → Claude Code sessions**. To keep disk use down, history of sessions you have not opened is read only if you turn on **Read unopened sessions in the background**, and never while the disk has less than the free space you set.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
