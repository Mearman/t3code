import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  latestRunId,
  threadAccountToConfirm,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadAccountConfirmAccess } from "./threadAccountConfirmAccess";

type FailureRow = Parameters<typeof threadAccountToConfirm>[0] & {
  readonly item: { readonly threadId: OrchestrationV2ProjectedTurnItem["item"]["threadId"] };
};

/**
 * Offered on the thread's latest turn when it was refused because the Claude account changed. It confirms the account that row names, which the server accepts only while still current.
 */
export function ThreadAccountConfirmButton(props: {
  readonly environmentId: EnvironmentId;
  readonly row: FailureRow;
}) {
  const gt = useGT();
  const confirm = useAtomCommand(serverEnvironment.confirmClaudeThreadAccount, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const latest = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(props.environmentId, props.row.item.threadId),
    ),
    (thread) => latestRunId(thread?.projection.runs ?? []),
  );
  const access = useThreadAccountConfirmAccess(props.environmentId);
  const account = threadAccountToConfirm(props.row, latest);
  if (account === undefined || !access) return null;
  return (
    <View className="ml-7 mt-2">
      <Button
        label={gt("Send as this account")}
        tone="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void confirm({
            environmentId: props.environmentId,
            input: { threadId: props.row.item.threadId, account },
          })
            .then((result) => {
              if (isAtomCommandInterrupted(result)) return;
              if (result._tag !== "Success") {
                const failure = squashAtomCommandFailure(result);
                Dialog.alert(
                  gt("Could not confirm the account"),
                  failure instanceof Error
                    ? (errorDisplayMessage(failure, m) ?? failure.message)
                    : undefined,
                );
                return;
              }
              const outcome = result.value.outcome;
              if (outcome === "confirmed")
                Dialog.alert(gt("Account confirmed"), gt("Send your message again."));
              else if (outcome === "stale")
                Dialog.alert(
                  gt("Claude is now signed in as another account. Send again to see which."),
                );
              else Dialog.alert(gt("This thread has no account change to confirm."));
            })
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}
