import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULTS = DEFAULT_SERVER_SETTINGS.claudeSessionSync;

/** Entries are separated by commas or new lines; blanks are dropped. */
function parseSettingList(text: string): ReadonlyArray<string> {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** A whole number of at least zero, or undefined when the text is not one. */
function parseNonNegativeInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function ClaudeSessionSyncSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const options = useScopedSettings((settings) => settings.claudeSessionSync);
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<typeof options>) => updateSettings({ claudeSessionSync: patch });

  return (
    <SettingsSection id="claude-sessions" title={gt("Claude Code sessions")}>
      <SettingsRow
        serverScoped
        settingKeys={["claudeSessionSync"]}
        {...setting("claude-session-sync")}
        description={gt(
          "Show every Claude Code session from this machine's Claude homes as a thread, and follow sessions a terminal is running.",
        )}
        control={
          <ScopedSwitch
            settingKeys={["claudeSessionSync"]}
            checked={options.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label={gt("Show Claude Code sessions")}
          />
        }
      />
      {options.enabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["claudeSessionSync"]}
            {...setting("claude-session-background-fill")}
            description={gt(
              "Read the history of sessions nobody has opened while the machine is idle. Off, a session's history is read when you open it.",
            )}
            control={
              <ScopedSwitch
                settingKeys={["claudeSessionSync"]}
                checked={options.backgroundFill}
                onCheckedChange={(checked) => update({ backgroundFill: Boolean(checked) })}
                aria-label={gt("Read unopened sessions in the background")}
              />
            }
          />
          {options.backgroundFill ? (
            <SettingsRow
              serverScoped
              settingKeys={["claudeSessionSync"]}
              title={gt("Fill recent sessions first (days)")}
              description={gt("Sessions changed within this many days are read before older ones.")}
              control={
                <DraftInput
                  size="sm"
                  inputMode="numeric"
                  className="w-full sm:w-24"
                  value={String(options.hydrateRecentDays)}
                  onCommit={(text) => {
                    const days = parseNonNegativeInt(text);
                    if (days !== undefined) update({ hydrateRecentDays: days });
                  }}
                  aria-label={gt("Fill recent sessions first (days)")}
                />
              }
            />
          ) : null}
          <SettingsRow
            serverScoped
            settingKeys={["claudeSessionSync"]}
            {...setting("claude-session-free-disk")}
            description={gt(
              "No session history is read while the disk holding T3 Code's data has less free space than this.",
            )}
            resetAction={
              options.minFreeDiskGiB !== DEFAULTS.minFreeDiskGiB ? (
                <SettingResetButton
                  ariaLabel={gt("Reset minimum free disk to default")}
                  onClick={() => update({ minFreeDiskGiB: DEFAULTS.minFreeDiskGiB })}
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                inputMode="numeric"
                className="w-full sm:w-24"
                value={String(options.minFreeDiskGiB)}
                onCommit={(text) => {
                  const gigabytes = parseNonNegativeInt(text);
                  if (gigabytes !== undefined) update({ minFreeDiskGiB: gigabytes });
                }}
                aria-label={gt("Minimum free disk (GB)")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["claudeSessionSync"]}
            {...setting("claude-session-additional-homes")}
            description={gt(
              "Further Claude homes to show sessions from, separated by commas. Each gets a Claude instance of its own, so a send uses that home's login.",
            )}
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={options.additionalHomes.join(", ")}
                onCommit={(text) => update({ additionalHomes: parseSettingList(text) })}
                placeholder="~/.claude-work"
                aria-label={gt("Additional Claude homes")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["claudeSessionSync"]}
            {...setting("claude-session-excluded-folders")}
            description={gt(
              "Sessions run in a folder matching one of these patterns, separated by commas, are archived and not followed.",
            )}
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={options.excludedCwdGlobs.join(", ")}
                onCommit={(text) => update({ excludedCwdGlobs: parseSettingList(text) })}
                placeholder="~/scratch/**"
                aria-label={gt("Excluded session folders")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["claudeSessionSync"]}
            {...setting("claude-session-restore")}
            description={gt(
              "Enter the id of a Claude Code session whose thread you deleted to show it again as a new thread.",
            )}
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value=""
                onCommit={(text) => {
                  const ids = parseSettingList(text);
                  if (ids.length > 0) {
                    update({ restoreSessionIds: [...options.restoreSessionIds, ...ids] });
                  }
                }}
                aria-label={gt("Restore a deleted session")}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
