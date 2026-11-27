import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useGT } from "gt-react-native";
import type { MenuAction } from "@react-native-menu/menu";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isManagedSettingPath,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";
import { m } from "../../i18n/messages";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claudeConfigDir,
  claudeEditorAction,
  DEFAULT_CLAUDE_INSTANCE_ID,
  planClaudeAccountSave,
  type ClaudeAccountDraft,
} from "./claude-accounts";
import type { SettingsTarget } from "./settings-environment-filter";

function useProviderInstanceMutation(environment: SettingsTarget) {
  const gt = useGT();
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(providerInstanceMutation: ProviderInstanceMutation) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await mutate({
      environmentId: environment.environmentId,
      input: { patch: {}, providerInstanceMutation },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Could not save the {provider} account.", { provider: "Claude" }),
      );
    }
    return false;
  }
  return { run, pending, error, setError };
}

export interface ClaudeAccountEditor {
  readonly detail: string;
  readonly actions: ReadonlyArray<MenuAction>;
  /** Runs an action from `actions`; false for an id this editor does not own. */
  readonly onAction: (id: string) => boolean;
  readonly pending: boolean;
  readonly panel: ReactNode;
}

/** Name and config-folder editing for a Claude instance, shared by both account rows. */
export function useClaudeAccountEditor(
  environment: SettingsTarget,
  provider: ServerProvider,
): ClaudeAccountEditor {
  const gt = useGT();
  const [editing, setEditing] = useState(false);
  const { run, pending, error } = useProviderInstanceMutation(environment);
  const instance = environment.serverConfig.settings.providerInstances[provider.instanceId];
  const configDir = claudeConfigDir(instance);
  const name = provider.displayName ?? "Claude";
  const removable =
    provider.instanceId !== DEFAULT_CLAUDE_INSTANCE_ID &&
    !isManagedSettingPath(
      environment.serverConfig.managedPolicy,
      `providerInstances.${provider.instanceId}`,
    );
  const actions: MenuAction[] = editing
    ? []
    : [
        { id: "claude:edit", title: gt("Edit"), image: "pencil" },
        ...(removable
          ? [
              {
                id: "claude:remove",
                title: gt("Remove"),
                image: "trash",
                attributes: { destructive: true },
              } satisfies MenuAction,
            ]
          : []),
      ];
  function remove() {
    Dialog.alert(
      gt("Remove {account}?", { account: name }),
      gt(
        "It leaves the model picker on {environment}. The config folder and its sign-in stay on the server.",
        { environment: environment.label },
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Remove"),
          style: "destructive",
          onPress: () => {
            void run({ operation: "remove", instanceId: provider.instanceId });
          },
        },
      ],
    );
  }
  return {
    detail: configDir || gt("Default config folder"),
    actions,
    pending,
    onAction: (id) => {
      const action = claudeEditorAction(id, pending);
      if (action === "edit") setEditing(true);
      else if (action === "remove") remove();
      return action !== undefined;
    },
    panel: editing ? (
      <ClaudeAccountForm
        environment={environment}
        instanceId={provider.instanceId}
        initial={{ name: instance?.displayName ?? "", configDir }}
        signsIn={provider.setup?.canAuthenticate === true}
        onDone={() => setEditing(false)}
      />
    ) : error ? (
      <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
        {error}
      </Text>
    ) : null,
  };
}

/** A Claude instance on a server that has no in-app Claude sign-in. */
export function ClaudeAccount({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const gt = useGT();
  const editor = useClaudeAccountEditor(environment, provider);
  const name = provider.displayName ?? "Claude";
  const status = !provider.enabled
    ? gt("Turned off")
    : provider.auth.status === "authenticated"
      ? gt("Signed in")
      : provider.auth.status === "unauthenticated"
        ? gt("Not signed in")
        : !provider.installed
          ? gt("Not installed")
          : null;
  return (
    <View className="border-t border-border-subtle">
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 shrink grow gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {[status, editor.detail].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {editor.actions.length === 0 ? null : (
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={gt("{account} options", { account: name })}
            title={name}
            actions={[...editor.actions]}
            onPressAction={({ nativeEvent }) => {
              editor.onAction(nativeEvent.event);
            }}
          >
            <ControlPill
              icon="ellipsis"
              accessibilityLabel={gt("{account} options", { account: name })}
              disabled={editor.pending}
            />
          </Menu>
        )}
      </View>
      {editor.panel}
    </View>
  );
}

/** `signsIn`: the server's Claude instances sign in from the app, so a new folder need not. */
export function AddClaudeAccount({
  environment,
  signsIn,
}: {
  readonly environment: SettingsTarget;
  readonly signsIn: boolean;
}) {
  const gt = useGT();
  const [adding, setAdding] = useState(false);
  return (
    <View className="border-t border-border-subtle">
      {adding ? (
        <ClaudeAccountForm
          environment={environment}
          instanceId={null}
          initial={{ name: "", configDir: "" }}
          signsIn={signsIn}
          onDone={() => setAdding(false)}
        />
      ) : (
        <ListActionRow
          icon="plus"
          label={gt("Add {provider} account", { provider: "Claude" })}
          description={
            signsIn
              ? gt(
                  "Use another {provider} config folder on this server, then sign in to it here.",
                  {
                    provider: "Claude",
                  },
                )
              : gt("Use a {provider} config folder that is already signed in on this server.", {
                  provider: "Claude",
                })
          }
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}

function ClaudeAccountForm({
  environment,
  instanceId,
  initial,
  signsIn,
  onDone,
}: {
  readonly environment: SettingsTarget;
  readonly instanceId: ProviderInstanceId | null;
  readonly initial: ClaudeAccountDraft;
  readonly signsIn: boolean;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(initial);
  const { run, pending, error, setError } = useProviderInstanceMutation(environment);
  function save() {
    const plan = planClaudeAccountSave({
      providerInstances: environment.serverConfig.settings.providerInstances,
      policy: environment.serverConfig.managedPolicy,
      instanceId,
      draft,
    });
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    void run(plan.mutation).then((saved) => {
      if (saved) onDone();
    });
  }
  function field(key: keyof ClaudeAccountDraft, label: string, placeholder: string) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!pending}
        value={draft[key]}
        onChangeText={(value) => setDraft((current) => ({ ...current, [key]: value }))}
      />
    );
  }
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {signsIn
          ? gt(
              "Point at a {variable} folder on {environment}. Sign in to it here once it is saved.",
              {
                variable: "CLAUDE_CONFIG_DIR",
                environment: environment.label,
              },
            )
          : gt(
              "Point at a {variable} folder on {environment} where {product} is already signed in. Sign in there with the {cli} first.",
              {
                variable: "CLAUDE_CONFIG_DIR",
                environment: environment.label,
                product: "Claude Code",
                cli: "Claude CLI",
              },
            )}
      </Text>
      {field("name", gt("Account name"), gt("Name, e.g. Work"))}
      {field(
        "configDir",
        gt("{provider} config folder", { provider: "Claude" }),
        gt("Config folder, e.g. {path}", { path: "~/.claude-work" }),
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-2">
        <ControlPill variant="pill" label={gt("Cancel")} disabled={pending} onPress={onDone} />
        <ControlPill
          variant="primary"
          label={instanceId === null ? gt("Add") : gt("Save")}
          disabled={pending}
          onPress={save}
        />
      </View>
    </View>
  );
}
