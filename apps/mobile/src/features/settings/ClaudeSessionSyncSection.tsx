import { claudeHeldSessionSendLabel } from "@t3tools/client-runtime/contract-labels";
import {
  ClaudeHeldSessionSend,
  type ClaudeSessionSyncSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { NumberField } from "../../components/ui/NumberField";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Entries are separated by commas or new lines; blanks are dropped. */
function parseSettingList(text: string): ReadonlyArray<string> {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// The largest value the number pickers offer; the server accepts any whole number.
const MAX_DAYS = 365;
const MAX_FREE_DISK_GIB = 1024;

function ListField(props: {
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="body">{props.label}</Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {props.description}
      </Text>
      <TextInput
        accessibilityLabel={props.label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        value={draft ?? props.value}
        onChangeText={setDraft}
        onEndEditing={() => {
          if (draft !== undefined) props.onCommit(draft);
          setDraft(undefined);
        }}
      />
    </View>
  );
}

/** The Claude Code session sync settings of the page's servers. */
export function ClaudeSessionSyncSection(props: {
  readonly options: ClaudeSessionSyncSettings;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { options, disabled } = props;
  const update = (patch: NonNullable<ServerSettingsPatch["claudeSessionSync"]>) =>
    props.write({ claudeSessionSync: patch });

  return (
    <SettingsSection title={gt("Claude Code sessions")}>
      <SettingsSwitchRow
        icon="terminal"
        label={gt("Show Claude Code sessions")}
        subtitle={gt(
          "Show every Claude Code session from this machine's Claude homes as a thread, and follow sessions a terminal is running.",
        )}
        value={options.enabled}
        disabled={disabled}
        onValueChange={(value) => update({ enabled: value })}
      />
      {options.enabled ? (
        <>
          <SettingsSwitchRow
            icon="clock"
            label={gt("Read unopened sessions in the background")}
            subtitle={gt(
              "Read the history of sessions nobody has opened while the machine is idle. Off, a session's history is read when you open it.",
            )}
            value={options.backgroundFill}
            disabled={disabled}
            onValueChange={(value) => update({ backgroundFill: value })}
          />
          {options.backgroundFill ? (
            <View className="px-4 py-3">
              <NumberField
                label={gt("Fill recent sessions first (days)")}
                min={0}
                max={MAX_DAYS}
                value={Math.min(options.hydrateRecentDays, MAX_DAYS)}
                disabled={disabled}
                onValueChange={(value) => update({ hydrateRecentDays: value })}
              />
            </View>
          ) : null}
          <View className="gap-1 px-4 pt-3">
            <Text textRole="body">{gt("Sending to an open session")}</Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {gt(
                "What a message you send does when another Claude Code process, such as a terminal, has the session open. Use default hands it to the terminal where that claude runs the T3 bridge mod, and otherwise asks; Send anyway writes beside an idle terminal, which branches the session.",
              )}
            </Text>
          </View>
          {(["default", ...ClaudeHeldSessionSend.literals] as const).map((choice, index) => (
            <ListChoiceRow
              key={choice}
              label={claudeHeldSessionSendLabel(choice, m)}
              selected={(options.heldSessionSend ?? "default") === choice}
              separated={index > 0}
              disabled={disabled}
              onPress={() => update({ heldSessionSend: choice === "default" ? null : choice })}
            />
          ))}
          <View className="px-4 py-3">
            <NumberField
              label={gt("Minimum free disk (GB)")}
              min={0}
              max={MAX_FREE_DISK_GIB}
              value={Math.min(options.minFreeDiskGiB, MAX_FREE_DISK_GIB)}
              disabled={disabled}
              onValueChange={(value) => update({ minFreeDiskGiB: value })}
            />
          </View>
          <ListField
            label={gt("Additional Claude homes")}
            description={gt(
              "Further Claude homes to show sessions from, separated by commas. Each gets a Claude instance of its own, so a send uses that home's login.",
            )}
            placeholder="~/.claude-work"
            value={options.additionalHomes.join(", ")}
            disabled={disabled}
            onCommit={(text) => update({ additionalHomes: parseSettingList(text) })}
          />
          <ListField
            label={gt("Excluded session folders")}
            description={gt(
              "Sessions run in a folder matching one of these patterns, separated by commas, are archived and not followed.",
            )}
            placeholder="~/scratch/**"
            value={options.excludedCwdGlobs.join(", ")}
            disabled={disabled}
            onCommit={(text) => update({ excludedCwdGlobs: parseSettingList(text) })}
          />
          <ListField
            label={gt("Restore a deleted session")}
            description={gt(
              "Enter the id of a Claude Code session whose thread you deleted to show it again as a new thread.",
            )}
            placeholder=""
            value=""
            disabled={disabled}
            onCommit={(text) => {
              const ids = parseSettingList(text);
              if (ids.length > 0) {
                update({ restoreSessionIds: [...options.restoreSessionIds, ...ids] });
              }
            }}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
