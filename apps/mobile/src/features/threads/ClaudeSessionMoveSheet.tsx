import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { claudeSessionIdOfThread } from "@t3tools/client-runtime/state/claude-session-replication";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeSessionMoveResult, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { claudeReplicationEnvironment } from "../../state/claudeReplication";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const TITLE = msg("Move to another machine");

type MoveState =
  | { readonly status: "idle" }
  | { readonly status: "moving" }
  | { readonly status: "moved"; readonly result: ClaudeSessionMoveResult }
  | { readonly status: "failed"; readonly message: string };

type MoveTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * Moves a thread's Claude Code session and its code to a linked machine, then shows how to resume
 * it.
 */
export function ClaudeSessionMoveSheet({ route }: StaticScreenProps<MoveTarget>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = route.params;
  const sessionId = claudeSessionIdOfThread(threadId);
  const links = useEnvironmentQuery(peerLinkEnvironment.names({ environmentId, input: {} }));
  const canMove = useAtomValue(claudeReplicationEnvironment.move.permissionAtom(environmentId));
  const move = useAtomCommand(claudeReplicationEnvironment.move, { reportFailure: false });
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [takeOver, setTakeOver] = useState(false);
  const [state, setState] = useState<MoveState>({ status: "idle" });
  const moving = state.status === "moving";
  const close = () => navigation.goBack();
  // A move in flight keeps going on the server; the sheet stays so its result is shown.
  usePreventRemove(moving, () => {});
  const choices = links.data?.links ?? [];
  const chosen = target ?? choices[0]?.environmentId ?? null;

  const run = async () => {
    if (chosen === null || sessionId === null) return;
    setState({ status: "moving" });
    const result = await move({
      environmentId,
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

  const copy = async (text: string) => {
    if (!(await tryCopyTextWithHaptic(text, { target: "resume command" }))) {
      Dialog.alert(gt("Could not copy"), gt("Try again."));
    }
  };

  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {state.status === "moved" ? (
        <View className="gap-3">
          {state.result.worktreePath === null ? null : (
            <Text className="text-sm text-foreground">
              {gt("The code is in {path} on branch {branch}.", {
                path: state.result.worktreePath,
                branch: state.result.branch ?? "",
              })}
            </Text>
          )}
          <View className="rounded-2xl border border-input-border bg-input px-3.5 py-3">
            <Text selectable className="font-mono text-sm text-foreground">
              {state.result.resumeCommand}
            </Text>
          </View>
          <Button
            label={gt("Copy resume command")}
            icon="doc.on.doc"
            fullWidth
            onPress={() => void copy(state.result.resumeCommand)}
          />
          {state.result.warnings.map((warning) => (
            <Text key={warning} className="text-sm text-warning-foreground">
              {warning}
            </Text>
          ))}
        </View>
      ) : (
        <>
          <Text className="text-sm leading-normal text-foreground-secondary">
            <T>
              The session moves with its unpushed commits and uncommitted changes, into a new
              worktree there. Ignored files such as .env stay here, and so does a copy of the
              session.
            </T>
          </Text>
          {choices.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No linked machine to move to. Link one in Settings.</T>
            </Text>
          ) : (
            <View className="gap-2">
              {choices.map((choice) => (
                <Button
                  key={choice.environmentId}
                  label={choice.label}
                  tone={choice.environmentId === chosen ? "primary" : "secondary"}
                  fullWidth
                  onPress={() => setTarget(choice.environmentId)}
                />
              ))}
            </View>
          )}
          <View className="flex-row items-center gap-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground">
              <T>
                Take over if a terminal has it open: an idle claude there is ended first. A working
                one is never ended.
              </T>
            </Text>
            <Switch
              accessibilityLabel={gt("Take over a terminal's session")}
              value={takeOver}
              onValueChange={setTakeOver}
            />
          </View>
          {state.status === "failed" ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {state.message}
            </Text>
          ) : null}
          <Button
            label={moving ? gt("Moving…") : gt("Move")}
            tone="primary"
            fullWidth
            loading={moving}
            disabled={!canMove || chosen === null || sessionId === null}
            onPress={() => void run()}
          />
        </>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={m(TITLE)}
          onClose={close}
          dismissDisabled={moving}
        />
        {content}
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AppBar sheet title={m(TITLE)} hideBottomBorder onBack={close} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
