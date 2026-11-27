import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { claudeHeldSessionSendLabel } from "@t3tools/client-runtime/contract-labels";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { heldSessionResendRunId } from "@t3tools/client-runtime/state/thread-workflows";
import {
  type ClaudeHeldSessionSend,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type RunId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { waitForThreadShell } from "./threadForkNavigation";

// Choices that resend the refused message itself; the fork is offered beside them.
const HELD_SESSION_RESEND_CHOICES = ["takeOver"] as const satisfies ReadonlyArray<ClaudeHeldSessionSend>;

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
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const title = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) => thread?.projection.thread.title,
  );
  // Only the latest refused run can be resent; the server refuses any other.
  const resendable = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) =>
      thread !== undefined && heldSessionResendRunId(thread.projection) === props.refusedRunId,
  );
  const runtimeMode = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) => thread?.projection.thread.runtimeMode,
  );
  const gt = useGT();
  const m = useMessages();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork held session");
  const resend = useAtomCommand(threadEnvironment.startTurn, "resend to held session");
  const selectDetail = useSelectWorkspaceDetail();
  const [busy, setBusy] = useState(false);
  if (title === undefined || runtimeMode === undefined) return null;
  return (
    <View className="ml-7 mt-2 gap-2">
      {resendable
        ? HELD_SESSION_RESEND_CHOICES.map((choice) => (
            <Button
              key={choice}
              label={claudeHeldSessionSendLabel(choice, m)}
              tone="secondary"
              disabled={busy}
              onPress={() => {
                setBusy(true);
                void Haptics.selectionAsync();
                void resend({
                  environmentId: props.environmentId,
                  input: {
                    threadId: props.threadId,
                    manualContinuationOfRunId: props.refusedRunId,
                    heldSessionSend: choice,
                    message: {
                      messageId: MessageId.make(uuidv4()),
                      role: "user",
                      text: "",
                      attachments: [],
                    },
                    runtimeMode,
                    interactionMode: "default",
                    dispatchMode: "start",
                    creationSource: "mobile",
                  },
                }).finally(() => setBusy(false));
              }}
            />
          ))
        : null}
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
