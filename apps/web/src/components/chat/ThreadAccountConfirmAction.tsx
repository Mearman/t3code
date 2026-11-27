import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canConfirmThreadAccount,
  latestRunId,
  threadAccountToConfirm,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useQuietThreadProjection, useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

type FailureRow = Parameters<typeof threadAccountToConfirm>[0] & {
  readonly item: { readonly threadId: OrchestrationV2ProjectedTurnItem["item"]["threadId"] };
};

/**
 * Offered on the thread's latest turn when it was refused because the Claude account changed. It confirms the account that row names, which the server accepts only while still current.
 */
export function ThreadAccountConfirmAction(props: {
  readonly environmentId: EnvironmentId;
  readonly row: FailureRow;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const confirm = useAtomCommand(serverEnvironment.confirmClaudeThreadAccount, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const permitted = useAtomValue(
    serverEnvironment.confirmClaudeThreadAccount.permissionAtom(props.environmentId),
  );
  const serverConfirms =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.claudeThreadAccounts ===
    true;
  const runs =
    useQuietThreadProjection(scopeThreadRef(props.environmentId, props.row.item.threadId))
      ?.projection.runs ?? [];
  const account = threadAccountToConfirm(props.row, latestRunId(runs));
  if (account === undefined || !canConfirmThreadAccount({ serverConfirms, permitted })) return null;
  return (
    <div className="ms-7 pb-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void confirm({
            environmentId: props.environmentId,
            input: { threadId: props.row.item.threadId, account },
          })
            .then((result) => {
              if (isAtomCommandInterrupted(result)) return;
              if (result._tag !== "Success") {
                const failure = squashAtomCommandFailure(result);
                toastManager.add({
                  type: "error",
                  title: gt("Could not confirm the account"),
                  description:
                    failure instanceof Error
                      ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
                      : undefined,
                });
                return;
              }
              const outcome = result.value.outcome;
              toastManager.add(
                outcome === "confirmed"
                  ? { type: "success", title: gt("Account confirmed. Send your message again.") }
                  : outcome === "stale"
                    ? {
                        type: "info",
                        title: gt(
                          "Claude is now signed in as another account. Send again to see which.",
                        ),
                      }
                    : { type: "info", title: gt("This thread has no account change to confirm.") },
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        <T>Send as this account</T>
      </Button>
    </div>
  );
}
