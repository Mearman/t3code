import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { canConfirmThreadAccount } from "@t3tools/client-runtime/state/thread-workflows";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Offered on a turn refused because the thread's Claude account changed; the row names both. */
export function ThreadAccountConfirmAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const confirm = useAtomCommand(serverEnvironment.confirmClaudeThreadAccount, "confirm account");
  const [busy, setBusy] = useState(false);
  const permitted = useAtomValue(
    serverEnvironment.confirmClaudeThreadAccount.permissionAtom(props.environmentId),
  );
  const serverConfirms =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.claudeThreadAccounts ===
    true;
  // Without the button, the refusal's own advice to send again confirms the account.
  if (!canConfirmThreadAccount({ serverConfirms, permitted })) return null;
  return (
    <div className="ms-7 pb-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void confirm({ environmentId: props.environmentId, input: { threadId: props.threadId } })
            .then((result) => {
              if (result._tag !== "Success") return;
              toastManager.add(
                result.value.confirmed
                  ? { type: "success", title: gt("Account confirmed. Send your message again.") }
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
