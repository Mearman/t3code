import {
  claudeAccountLabel,
  claudeMoveTargets,
  summariseClaudeMove,
} from "@t3tools/client-runtime/claudeAccountMove";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeThreadMoveInput,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Moving threads to another Claude account through native alerts: pick the account, confirm with
 * both accounts named and the choice to compact, then report what stayed and why.
 */
export function useClaudeAccountMove(environmentId: EnvironmentId) {
  const gt = useGT();
  const config = useEnvironmentServerConfig(environmentId);
  const move = useAtomCommand(serverEnvironment.moveClaudeThreads, { reportFailure: false });
  const supported = config?.environment.capabilities.claudeAccountMoves === true;
  const providers: ReadonlyArray<ServerProvider> = config?.providers ?? [];
  const compactByDefault = config?.settings.claudeSessionSync.compactBeforeAccountMove ?? true;

  const canMove = (sourceInstanceId: ProviderInstanceId) =>
    supported &&
    providers.some(
      (provider) => provider.instanceId === sourceInstanceId && provider.driver === "claudeAgent",
    ) &&
    claudeMoveTargets(providers, sourceInstanceId).length > 0;

  const run = async (
    selection: ClaudeThreadMoveInput["selection"],
    target: ServerProvider,
    from: string,
    compact: boolean,
  ) => {
    const to = claudeAccountLabel(target);
    const result = await move({
      environmentId,
      input: { selection, targetInstanceId: target.instanceId, compact },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag !== "Success") {
      Dialog.alert(gt("Could not move"), gt("Reconnect and try again."));
      return;
    }
    const summary = summariseClaudeMove(result.value.outcomes);
    const refused = summary.refused.map((outcome) => outcome.detail).filter(Boolean);
    if (summary.uncompacted.length > 0) {
      Dialog.alert(
        gt("{from} could not compact", { from }),
        gt(
          "{count, plural, one {{count} thread stayed on {from}.} other {{count} threads stayed on {from}.}} Move without compacting to send the full history to {to}.",
          { count: summary.uncompacted.length, from, to },
        ),
        [
          { text: gt("Cancel"), style: "cancel" },
          {
            text: gt("Move without compacting"),
            onPress: () => void run({ threadIds: [...summary.uncompacted] }, target, from, false),
          },
        ],
      );
      return;
    }
    Dialog.alert(
      gt(
        "{count, plural, =0 {No threads moved} one {Moved {count} thread to {to}} other {Moved {count} threads to {to}}}",
        { count: summary.moved, to },
      ),
      refused.length > 0 ? refused.join("\n") : undefined,
    );
  };

  const confirm = (
    selection: ClaudeThreadMoveInput["selection"],
    source: ServerProvider,
    target: ServerProvider,
  ) => {
    const from = claudeAccountLabel(source);
    const to = claudeAccountLabel(target);
    const compactFirst = {
      text: gt("Compact, then move"),
      onPress: () => void run(selection, target, from, true),
    };
    const moveNow = {
      text: gt("Move without compacting"),
      onPress: () => void run(selection, target, from, false),
    };
    Dialog.alert(
      gt("Move to {to}?", { to }),
      gt(
        "The conversation history goes to {to}, and the thread continues there instead of on {from}. Compacting first runs under {from}, so {to} starts from a summary.",
        { from, to },
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        ...(compactByDefault ? [compactFirst, moveNow] : [moveNow, compactFirst]),
      ],
    );
  };

  /**
   * Starts a move of one thread, or of every thread on `sourceInstanceId` when no thread is given.
   */
  const startMove = (sourceInstanceId: ProviderInstanceId, threadId?: ThreadId) => {
    const source = providers.find((provider) => provider.instanceId === sourceInstanceId);
    const targets = claudeMoveTargets(providers, sourceInstanceId);
    if (source === undefined || targets.length === 0) return;
    const selection: ClaudeThreadMoveInput["selection"] =
      threadId === undefined ? { fromInstanceId: sourceInstanceId } : { threadIds: [threadId] };
    if (targets.length === 1) {
      confirm(selection, source, targets[0]!);
      return;
    }
    Dialog.alert(gt("Move to which account?"), undefined, [
      ...targets.map((target) => ({
        text: claudeAccountLabel(target),
        onPress: () => confirm(selection, source, target),
      })),
      { text: gt("Cancel"), style: "cancel" as const },
    ]);
  };

  return { canMove, startMove };
}
