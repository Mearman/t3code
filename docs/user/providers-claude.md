# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Sign in

**Settings → Providers → Claude → Sign in** (or **Providers** on mobile) signs Claude Code in on the environment's machine, so it works from a phone or another computer. Open the sign-in page, sign in, then paste the code the page shows. **Anthropic Console** signs in for API billing instead of a subscription. If the installed Claude Code cannot sign in this way, T3 Code runs `claude auth login` in a terminal instead. **Sign out** runs `claude auth logout` for that instance's config directory.

## Multiple accounts and presets

**Add Claude account** (in **Settings → Providers → Add provider → Claude**, or **Providers** on mobile) creates a new account with its own config folder on the environment's machine, then signs it in. By default it shares projects, sessions, file history and tasks with an existing Claude account, so `claude --resume` finds the same sessions from either account; choose **Keep history separate** to give it its own.

To use a config folder you already have, such as `~/.claude_personal`, add a Claude instance and point **CLAUDE_CONFIG_DIR path** at it (leave empty for the default directory), then sign in to it as above. Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads can only switch between Claude instances sharing the same config directory.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

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

Every Claude Code session in your Claude homes shows up as a thread, in the project of the folder it ran in. A session a terminal is running is followed as it goes; an older one shows its history when you open it, with a "Loading this session's history" note in the thread until it has loaded. A thread whose latest activity came from a terminal carries a **Terminal** badge in the thread list and in the thread's header on the web, and in the list on mobile. A session a terminal still holds refuses a message sent from T3 Code and offers to fork it into a new session; set **Sending to an open session** to **Continue in a fork** and T3 Code forks the conversation and sends your message there itself (a message with attachments is carried into the fork for you to send again). **Take over when idle** stops the terminal's `claude` once it is waiting for a prompt (never mid-turn; until then the message waits) and sends from T3 Code, and the refused message offers the same for one send. It stops only a `claude` started from a terminal, and needs a connection allowed to use terminals; otherwise the message is refused as **Ask each time** would. **Send anyway** sends while the terminal waits for a prompt, writing beside it: the session then branches, since the terminal's next prompt continues from before T3 Code's reply, and `claude --resume` follows one side. T3 Code says so under the reply. Like taking over, it writes only beside a `claude` started from a terminal and needs a connection allowed to use terminals. `t3 thread send --held-session fork` forks for one message from the command line; the command line and agents cannot take over or send beside a terminal. Send to a session no terminal holds and T3 Code continues that same session, so `claude --resume <id>` in the terminal picks up where it left off (with `CLAUDE_CONFIG_DIR` set for a home other than `~/.claude`). Turn it off, add further Claude homes, exclude folders or restore a session whose thread you deleted under **Settings → Threads → Claude Code sessions**. To keep disk use down, history of sessions you have not opened is read only if you turn on **Read unopened sessions in the background**, and never while the disk has less than the free space you set.

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
