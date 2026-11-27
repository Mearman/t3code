import { useAtomValue } from "@effect/atom-react";
import { claudeSessionIdOfThread } from "@t3tools/client-runtime/state/claude-session-replication";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeSessionMoveResult, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { claudeReplicationEnvironment } from "~/state/claudeReplication";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Input } from "../ui/input";
import { claudeSessionMoveDialogThreadAtom } from "./claudeSessionMoveDialogState";

export function ClaudeSessionMoveDialogHost() {
  const threadRef = useAtomValue(claudeSessionMoveDialogThreadAtom);
  const sessionId = threadRef === null ? null : claudeSessionIdOfThread(threadRef.threadId);
  if (threadRef === null || sessionId === null) return null;
  return (
    <ClaudeSessionMoveDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      sessionId={sessionId}
      onClose={() => appAtomRegistry.set(claudeSessionMoveDialogThreadAtom, null)}
    />
  );
}

type MoveState =
  | { readonly status: "idle" }
  | { readonly status: "moving" }
  | { readonly status: "moved"; readonly result: ClaudeSessionMoveResult }
  | { readonly status: "failed"; readonly message: string };

/**
 * Moves a Claude Code session and the code it ran in to a linked machine, which then owns it; this
 * machine keeps a copy. Shows the command that resumes it there with plain `claude`.
 */
function ClaudeSessionMoveDialog({
  threadRef,
  sessionId,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.names({ environmentId: threadRef.environmentId, input: {} }),
  );
  const canMove = useAtomValue(
    claudeReplicationEnvironment.move.permissionAtom(threadRef.environmentId),
  );
  const move = useAtomCommand(claudeReplicationEnvironment.move, { reportFailure: false });
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [takeOver, setTakeOver] = useState(false);
  const [state, setState] = useState<MoveState>({ status: "idle" });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "resume command",
      unavailableMessage: msg("Clipboard API is unavailable while copying the resume command."),
      failureMessage: msg("Failed to copy the resume command to the clipboard."),
    },
  });
  const choices = links.data?.links ?? [];
  const chosen = target ?? choices[0]?.environmentId ?? null;

  const run = async () => {
    if (chosen === null) return;
    setState({ status: "moving" });
    const result = await move({
      environmentId: threadRef.environmentId,
      input: { sessionId, targetEnvironmentId: chosen, takeOver },
    });
    if (result._tag === "Success") {
      setState({ status: "moved", result: result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : gt("The session could not be moved."),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "moving") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Move to another machine</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              The session moves with its unpushed commits and uncommitted changes, into a new
              worktree there. Ignored files such as .env stay here, and so does a copy of the
              session.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            {state.status === "moved" ? (
              <>
                {state.result.worktreePath === null ? null : (
                  <p>
                    {gt("The code is in {path} on branch {branch}.", {
                      path: state.result.worktreePath,
                      branch: state.result.branch ?? "",
                    })}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label={gt("Resume command")}
                    value={state.result.resumeCommand}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(state.result.resumeCommand)}
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? gt("Copied") : gt("Copy", { $context: "verb, copy the command" })}
                  </Button>
                </div>
                {state.result.warnings.map((warning) => (
                  <p key={warning} className="text-warning-foreground">
                    {warning}
                  </p>
                ))}
              </>
            ) : choices.length === 0 ? (
              <p className="text-muted-foreground">
                <T>No linked machine to move to. Link one in Settings → Connections.</T>
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={gt("Machine")}>
                  {choices.map((choice) => (
                    <Button
                      key={choice.environmentId}
                      size="sm"
                      role="radio"
                      aria-checked={choice.environmentId === chosen}
                      variant={choice.environmentId === chosen ? "secondary" : "outline"}
                      onClick={() => setTarget(choice.environmentId)}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </div>
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={takeOver}
                    onCheckedChange={(checked) => setTakeOver(checked === true)}
                  />
                  <span>
                    <T>
                      Take over if a terminal has it open: an idle claude there is ended first. A
                      working one is never ended.
                    </T>
                  </span>
                </label>
              </>
            )}
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {state.status === "moved" ? (
            <Button size="sm" onClick={onClose}>
              <T context="button that closes the dialog">Done</T>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={state.status === "moving"}
              >
                <T>Cancel</T>
              </Button>
              <Button
                size="sm"
                onClick={() => void run()}
                disabled={!canMove || chosen === null || state.status === "moving"}
              >
                {state.status === "moving" ? gt("Moving...") : gt("Move")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
