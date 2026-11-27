import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Offered on a turn refused because the thread's Claude account changed; the row names both. */
export function ThreadAccountConfirmButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const confirm = useAtomCommand(serverEnvironment.confirmClaudeThreadAccount, "confirm account");
  const [busy, setBusy] = useState(false);
  return (
    <View className="ml-7 mt-2">
      <Button
        label={gt("Send as this account")}
        tone="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void confirm({ environmentId: props.environmentId, input: { threadId: props.threadId } })
            .then((result) => {
              if (isAtomCommandInterrupted(result) || result._tag !== "Success") return;
              Dialog.alert(
                result.value.confirmed
                  ? gt("Account confirmed")
                  : gt("This thread has no account change to confirm."),
                result.value.confirmed ? gt("Send your message again.") : undefined,
              );
            })
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}
