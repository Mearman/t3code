import {
  claudeAccountLabel,
  moveClaudeThreadsInTurn,
  summariseClaudeMove,
} from "@t3tools/client-runtime/claudeAccountMove";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { claudeMoveMenuAction, claudeMoveMenuTarget } from "./claudeAccountMoveMenu";

/**
 * Moving threads to another Claude account: the menu lists the accounts, an alert confirms with
 * both accounts named and the choice to compact, then reports what stayed and why.
 */
export function useClaudeAccountMove(environmentId: EnvironmentId) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const config = useEnvironmentServerConfig(environmentId);
  const move = useAtomCommand(serverEnvironment.moveClaudeThreads, { reportFailure: false });
  const list = useAtomCommand(serverEnvironment.listClaudeThreadsToMove, { reportFailure: false });
  const [progress, setProgress] = useState<{
    readonly to: string;
    readonly done: number;
    readonly total: number;
  } | null>(null);
  const supported = config?.environment.capabilities.claudeAccountMoves === true;
  const sharedHistoryOnly =
    config?.environment.capabilities.claudeAccountMovesSharedHistoryOnly === true;
  const providers: ReadonlyArray<ServerProvider> = config?.providers ?? [];
  const compactByDefault = config?.settings.claudeSessionSync.compactBeforeAccountMove ?? true;

  const canMove = (sourceInstanceId: ProviderInstanceId) =>
    supported &&
    canManage &&
    providers.some(
      (provider) => provider.instanceId === sourceInstanceId && provider.driver === "claudeAgent",
    );

  const describe = (failure: unknown) =>
    failure instanceof Error
      ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
      : gt("Reconnect and try again.");

  /** Moves these threads, or every thread on the source account when `threadIds` is undefined. */
  const run = async (
    threadIds: ReadonlyArray<ThreadId> | undefined,
    source: ServerProvider,
    target: ServerProvider,
    compact: boolean,
  ) => {
    const from = claudeAccountLabel(source);
    const to = claudeAccountLabel(target);
    let ids = threadIds;
    if (ids === undefined) {
      const listed = await list({ environmentId, input: { instanceId: source.instanceId } });
      if (isAtomCommandInterrupted(listed)) return;
      if (listed._tag !== "Success") {
        Dialog.alert(gt("Could not move"), describe(squashAtomCommandFailure(listed)));
        return;
      }
      ids = listed.value.threadIds;
    }
    const moved = await moveClaudeThreadsInTurn({
      threadIds: ids,
      moveThread: async (threadId) => {
        const result = await move({
          environmentId,
          input: { threadIds: [threadId], targetInstanceId: target.instanceId, compact },
        });
        return result._tag === "Success"
          ? { outcomes: result.value.outcomes }
          : { failure: squashAtomCommandFailure(result) };
      },
      onProgress: (done, total) => setProgress(total > 1 ? { to, done, total } : null),
    });
    setProgress(null);
    if (moved.failure !== undefined && moved.outcomes.length === 0) {
      Dialog.alert(gt("Could not move"), describe(moved.failure));
      return;
    }
    const summary = summariseClaudeMove(moved.outcomes);
    const refused = summary.refused.map((outcome) => outcome.detail).filter(Boolean);
    // A request that failed part-way left the rest untried, which the reader must also see.
    const stopped =
      moved.failure === undefined
        ? []
        : [describe(moved.failure), gt("The remaining threads were not moved.")];
    const movedCount = gt(
      "{count, plural, =0 {No threads moved} one {Moved {count} thread to {to}} other {Moved {count} threads to {to}}}",
      { count: summary.moved, to },
    );
    if (summary.uncompacted.length > 0) {
      Dialog.alert(
        gt("{from} could not compact", { from }),
        [
          ...(summary.moved > 0 ? [`${movedCount}.`] : []),
          gt(
            "{count, plural, one {{count} thread stayed on {from}.} other {{count} threads stayed on {from}.}} Move without compacting to send the full history to {to}.",
            { count: summary.uncompacted.length, from, to },
          ),
          ...refused,
          ...stopped,
        ].join("\n"),
        [
          { text: gt("Cancel"), style: "cancel" },
          {
            text: gt("Move without compacting"),
            onPress: () => void run(summary.uncompacted, source, target, false),
          },
        ],
      );
      return;
    }
    Dialog.alert(
      movedCount,
      [...refused, ...stopped].length > 0 ? [...refused, ...stopped].join("\n") : undefined,
    );
  };

  const confirm = (
    threadIds: ReadonlyArray<ThreadId> | undefined,
    source: ServerProvider,
    target: ServerProvider,
  ) => {
    const from = claudeAccountLabel(source);
    const to = claudeAccountLabel(target);
    const compactFirst = {
      text: gt("Compact, then move"),
      onPress: () => void run(threadIds, source, target, true),
    };
    const moveNow = {
      text: gt("Move without compacting"),
      onPress: () => void run(threadIds, source, target, false),
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
   * The menu item that moves one thread, or every thread on `sourceInstanceId` when the caller
   * passes no thread; undefined when this client cannot move them.
   */
  const menuAction = (
    sourceInstanceId: ProviderInstanceId,
    item: Omit<MenuAction, "id" | "subactions">,
  ): MenuAction | undefined =>
    canMove(sourceInstanceId)
      ? claudeMoveMenuAction(providers, sourceInstanceId, item, sharedHistoryOnly)
      : undefined;

  /** Starts the move a `menuAction` item names; false for any other menu id. */
  const handleMenuAction = (
    id: string,
    sourceInstanceId: ProviderInstanceId,
    threadId?: ThreadId,
  ): boolean => {
    const target = claudeMoveMenuTarget(providers, sourceInstanceId, id, sharedHistoryOnly);
    if (target === undefined) return false;
    const source = providers.find((provider) => provider.instanceId === sourceInstanceId);
    if (source === undefined || target === null) return true;
    confirm(threadId === undefined ? undefined : [threadId], source, target);
    return true;
  };

  /** While a whole-account move runs: how many of its threads have finished. */
  const progressMessage =
    progress === null
      ? undefined
      : gt("Moving threads to {to}: {done} of {total} done", {
          to: progress.to,
          done: progress.done,
          total: progress.total,
        });

  return { menuAction, handleMenuAction, progressMessage };
}
