import { useAtomValue } from "@effect/atom-react";
import {
  claudeAccountLabel,
  claudeMoveTargets,
  moveClaudeThreadsInTurn,
  summariseClaudeMove,
  type ClaudeMoveSummary,
} from "@t3tools/client-runtime/claudeAccountMove";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { claudeMoveDialogAtom, type ClaudeMoveRequest } from "./claudeMoveDialogState";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

export function MoveClaudeAccountDialogHost() {
  const request = useAtomValue(claudeMoveDialogAtom);
  if (request === null) return null;
  return (
    <MoveClaudeAccountDialog
      key={`${request.environmentId}:${request.sourceInstanceId}:${request.threadId ?? "all"}`}
      request={request}
      onClose={() => appAtomRegistry.set(claudeMoveDialogAtom, null)}
    />
  );
}

function MoveClaudeAccountDialog({
  request,
  onClose,
}: {
  readonly request: ClaudeMoveRequest;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(request.environmentId)) ?? [];
  const defaultCompact = useEnvironmentSettings(
    request.environmentId,
    (settings) => settings.claudeSessionSync.compactBeforeAccountMove,
  );
  const move = useAtomCommand(serverEnvironment.moveClaudeThreads, { reportFailure: false });
  const list = useAtomCommand(serverEnvironment.listClaudeThreadsToMove, { reportFailure: false });
  const source = providers.find((provider) => provider.instanceId === request.sourceInstanceId);
  const sharedHistoryOnly =
    useServerConfigs().get(request.environmentId)?.environment.capabilities
      .claudeAccountMovesSharedHistoryOnly === true;
  const targets = claudeMoveTargets(providers, request.sourceInstanceId, sharedHistoryOnly);
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const target = targets.find((candidate) => candidate.instanceId === targetId) ?? targets[0];
  const [compact, setCompact] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ClaudeMoveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = source ? claudeAccountLabel(source) : "Claude";
  const to = target ? claudeAccountLabel(target) : "";

  const describe = (failure: unknown) =>
    failure instanceof Error
      ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
      : gt("The move failed.");

  const run = async (threadIds: ReadonlyArray<ThreadId> | undefined, withCompaction: boolean) => {
    if (target === undefined || pending) return;
    setPending(true);
    setError(null);
    let ids = threadIds;
    if (ids === undefined) {
      const listed = await list({
        environmentId: request.environmentId,
        input: { instanceId: request.sourceInstanceId },
      });
      if (listed._tag === "Failure") {
        setPending(false);
        setError(describe(squashAtomCommandFailure(listed)));
        return;
      }
      ids = listed.value.threadIds;
    }
    const moved = await moveClaudeThreadsInTurn({
      threadIds: ids,
      moveThread: async (threadId) => {
        const outcome = await move({
          environmentId: request.environmentId,
          input: {
            threadIds: [threadId],
            targetInstanceId: target.instanceId,
            compact: withCompaction,
          },
        });
        return outcome._tag === "Failure"
          ? { failure: squashAtomCommandFailure(outcome) }
          : { outcomes: outcome.value.outcomes };
      },
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setPending(false);
    setProgress(null);
    if (moved.failure !== undefined) setError(describe(moved.failure));
    const summary = summariseClaudeMove(moved.outcomes);
    if (moved.failure !== undefined) {
      setResult(summary);
      return;
    }
    if (summary.uncompacted.length === 0 && summary.refused.length === 0) {
      toastManager.add({
        type: "success",
        title: gt(
          "{count, plural, =0 {No threads to move} one {Moved {count} thread to {account}} other {Moved {count} threads to {account}}}",
          { count: summary.moved, account: to },
        ),
      });
      onClose();
      return;
    }
    setResult(summary);
  };

  const start = () =>
    run(request.threadId === undefined ? undefined : [request.threadId], compact ?? defaultCompact);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A move runs to the end on the server; closing now would only hide its result.
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {request.threadId === undefined ? (
              <T>
                Move every thread from <Var>{from}</Var>
              </T>
            ) : (
              <T>Move thread to another Claude account</T>
            )}
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <T>
                The conversation history goes to <Var>{to}</Var>, and the thread continues there
                instead of on <Var>{from}</Var>.
              </T>
            ) : (
              <T>Add another Claude account on this environment first.</T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {result ? (
              <div className="grid gap-2 text-sm">
                <p>
                  {gt(
                    "{count, plural, =0 {No threads moved.} one {{count} thread moved.} other {{count} threads moved.}}",
                    { count: result.moved },
                  )}
                </p>
                {result.uncompacted.length > 0 ? (
                  <p>
                    {gt(
                      "{count, plural, one {{from} could not compact {count} thread, so it stayed.} other {{from} could not compact {count} threads, so they stayed.}} Move them without compacting to send their full history to {to}.",
                      { count: result.uncompacted.length, from, to },
                    )}
                  </p>
                ) : null}
                {result.refused.map((outcome) => (
                  <p key={outcome.threadId} className="text-muted-foreground">
                    {outcome.detail ?? gt("A thread could not be moved.")}
                  </p>
                ))}
              </div>
            ) : target ? (
              <>
                <div className="grid gap-1.5">
                  <Label>
                    <T>Move to</T>
                  </Label>
                  <Select
                    value={target.instanceId}
                    disabled={pending}
                    onValueChange={(value) => setTargetId(value ?? undefined)}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Move to")}>
                      <SelectValue>{to}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((candidate) => (
                        <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                          {claudeAccountLabel(candidate)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="claude-move-compact"
                    checked={compact ?? defaultCompact}
                    disabled={pending}
                    onCheckedChange={(checked) => setCompact(checked === true)}
                  />
                  <Label htmlFor="claude-move-compact">
                    <span>
                      <T>
                        Compact under <Var>{from}</Var> first
                      </T>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      <T>
                        The new account starts from a summary. The full history stays in the
                        session.
                      </T>
                    </span>
                  </Label>
                </div>
              </>
            ) : null}
            {pending ? (
              <p role="status" className="text-xs text-muted-foreground">
                {progress !== null && progress.total > 1
                  ? gt("Moved {done} of {total} threads. Keep this open to see what moved.", {
                      done: progress.done,
                      total: progress.total,
                    })
                  : gt(
                      "Each thread compacts and moves in turn, which can take a few minutes. Keep this open to see what moved.",
                    )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {result ? <T>Close</T> : <T>Cancel</T>}
          </Button>
          {result && result.uncompacted.length > 0 ? (
            <Button disabled={pending} onClick={() => void run(result.uncompacted, false)}>
              <T>Move without compacting</T>
            </Button>
          ) : null}
          {!result && target ? (
            <Button disabled={pending} onClick={() => void start()}>
              {pending ? gt("Moving…") : gt("Move to {account}", { account: to })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
