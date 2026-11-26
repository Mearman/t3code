import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId, type RunId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { waitForThreadShell } from "./threadForkNavigation";

/**
 * Offered on this thread's own run refused because another process holds its session. The fork
 * starts from the refused run, which is never forked natively, so it carries what T3 Code
 * recorded and nothing only the other process wrote.
 */
export function HeldSessionForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly refusedRunId: RunId;
}) {
  const title = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => thread?.projection.thread.title,
  );
  const gt = useGT();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork held session");
  const selectDetail = useSelectWorkspaceDetail();
  const [busy, setBusy] = useState(false);
  if (title === undefined) return null;
  return (
    <View className="ml-7 mt-2">
      <Button
        label={gt("Fork into a new session")}
        tone="secondary"
        disabled={busy}
        icon="arrow.triangle.branch"
        onPress={() => {
          const targetThreadId = ThreadId.make(uuidv4());
          setBusy(true);
          void Haptics.selectionAsync();
          void forkFromRun({
            environmentId: props.environmentId,
            input: {
              sourceThreadId: props.threadId,
              targetThreadId,
              runId: props.refusedRunId,
              title: `${title} fork`,
              creationSource: "mobile",
            },
          })
            .then(async (result) => {
              if (isAtomCommandInterrupted(result)) return;
              if (result._tag !== "Success") {
                Dialog.alert(
                  gt("Could not confirm fork"),
                  gt("Reconnect and check the thread list before trying again."),
                );
                return;
              }
              const ready = await waitForThreadShell(
                scopeThreadRef(props.environmentId, targetThreadId),
              );
              if (!ready) {
                Dialog.alert(
                  gt("Fork created"),
                  gt(
                    "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
                  ),
                );
                return;
              }
              selectDetail({
                name: "Thread",
                params: { environmentId: props.environmentId, threadId: targetThreadId },
              });
            })
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}
