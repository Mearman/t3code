import {
  AuthOrchestrationOperateScope,
  type ClaudeReplicationReport,
  type ClaudeSessionReplicationRules,
  type EnvironmentId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { openLinkedThreadRead } from "../../lib/sideChatPane";
import { claudeReplicationEnvironment } from "../../state/claudeReplication";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const DEFAULTS = DEFAULT_SERVER_SETTINGS.claudeSessionSync.replication;

function parseNonNegativeInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

const formatTime = (time: DateTime.Utc) => new Date(DateTime.toEpochMillis(time)).toLocaleString();

/**
 * Which sessions owned by linked machines this machine keeps a copy of, the last pass's report, and
 * the linked machines' own sessions to open without copying them.
 */
export function ClaudeSessionReplicationSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly rules: ClaudeSessionReplicationRules;
  readonly update: (patch: Partial<ClaudeSessionReplicationRules>) => void;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { environmentId, rules, update } = props;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const report = useEnvironmentQuery(
    claudeReplicationEnvironment.report({ environmentId, input: {} }),
  );
  const replicateNow = useAtomCommand(claudeReplicationEnvironment.replicateNow);
  const [copying, setCopying] = useState(false);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["claudeSessionSync"]}
        {...setting("claude-session-replicate-pinned")}
        description={
          <T>
            Copy every session whose thread or project is pinned on a machine linked with full
            access. A copy includes backups of the files it edited, .env too, and resumes with plain{" "}
            <code className="whitespace-nowrap">claude --resume</code> here.
          </T>
        }
        control={
          <ScopedSwitch
            settingKeys={["claudeSessionSync"]}
            checked={rules.pinned}
            onCheckedChange={(checked) => update({ pinned: Boolean(checked) })}
            aria-label={gt("Keep pinned sessions from linked machines")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["claudeSessionSync"]}
        title={gt("Copy sessions active within (days)")}
        description={gt("Also copy sessions changed within this many days. 0 turns this off.")}
        control={
          <DraftInput
            size="sm"
            inputMode="numeric"
            className="w-full sm:w-24"
            value={String(rules.activeWithinDays)}
            onCommit={(text) => {
              const days = parseNonNegativeInt(text);
              if (days !== undefined) update({ activeWithinDays: days });
            }}
            aria-label={gt("Copy sessions active within (days)")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["claudeSessionSync"]}
        {...setting("claude-session-replicate-everything")}
        description={gt(
          "Copy every session linked machines own. Copies hold whatever their conversations did, secrets and client material included.",
        )}
        control={
          <ScopedSwitch
            settingKeys={["claudeSessionSync"]}
            checked={rules.everything}
            onCheckedChange={(checked) => update({ everything: Boolean(checked) })}
            aria-label={gt("Keep every session from linked machines")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["claudeSessionSync"]}
        title={gt("Keep free for copies (GB)")}
        description={gt(
          "A session is not copied while copying it would leave less free space than this on the disk holding the Claude home.",
        )}
        resetAction={
          rules.reserveGiB !== DEFAULTS.reserveGiB ? (
            <SettingResetButton
              ariaLabel={gt("Reset free space kept for copies to default")}
              onClick={() => update({ reserveGiB: DEFAULTS.reserveGiB })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            inputMode="numeric"
            className="w-full sm:w-24"
            value={String(rules.reserveGiB)}
            onCommit={(text) => {
              const gigabytes = parseNonNegativeInt(text);
              if (gigabytes !== undefined) update({ reserveGiB: gigabytes });
            }}
            aria-label={gt("Keep free for copies (GB)")}
          />
        }
      />
      <SettingsRow
        title={gt("Copies from linked machines")}
        description={
          report.data?.lastRunAt != null ? (
            <T>
              Last checked <Var>{formatTime(report.data.lastRunAt)}</Var>.
            </T>
          ) : (
            gt("Not checked yet since this server started.")
          )
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || copying}
            onClick={async () => {
              setCopying(true);
              await replicateNow({ environmentId, input: {} });
              setCopying(false);
            }}
          >
            {copying ? gt("Copying…") : gt("Copy now")}
          </Button>
        }
      />
      {report.data === null ? null : <ReplicationReport report={report.data} />}
      <LinkedSessions environmentId={environmentId} />
    </>
  );
}

function ReplicationReport(props: { readonly report: ClaudeReplicationReport }) {
  const gt = useGT();
  const { report } = props;
  const label = (environmentId: EnvironmentId) =>
    report.sources.find((source) => source.environmentId === environmentId)?.label ?? environmentId;
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      {report.sources.map((source) => (
        <p key={source.environmentId} className="text-muted-foreground">
          <span className="font-medium text-foreground">{source.label}</span>
          {": "}
          {source.outcome === "synced"
            ? gt("checked")
            : source.outcome === "unsupported"
              ? gt("does not share sessions")
              : source.outcome === "refused"
                ? gt("refused")
                : gt("did not answer; its copies are marked stale")}
          {source.message === null ? null : ` (${source.message})`}
        </p>
      ))}
      {report.replicas.length === 0 ? (
        <p className="text-muted-foreground">
          <T>No copies on this machine.</T>
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {report.replicas.map((replica) => (
            <li key={replica.sessionId} className="flex flex-wrap items-baseline gap-x-2">
              {replica.title === null ? (
                <code className="text-xs">{replica.sessionId}</code>
              ) : (
                <span>{replica.title}</span>
              )}
              <span
                className={replica.status === "stale" ? "text-warning" : "text-muted-foreground"}
              >
                {replica.status === "stale"
                  ? gt("stale since {time}, owned by {owner}", {
                      time: formatTime(replica.syncedAt),
                      owner: label(replica.ownerEnvironmentId),
                    })
                  : gt("current at {time}, owned by {owner}", {
                      time: formatTime(replica.syncedAt),
                      owner: label(replica.ownerEnvironmentId),
                    })}
              </span>
              {replica.forkedSessionIds.length > 0 ? (
                <span className="text-muted-foreground">
                  {gt("lines added here kept as {sessions}", {
                    sessions: replica.forkedSessionIds.join(", "),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {report.skipped.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            <T>Not copied</T>
          </p>
          <ul className="flex flex-col gap-1">
            {report.skipped.map((skip) => (
              <li
                key={`${skip.ownerEnvironmentId}:${skip.sessionId}`}
                className="text-muted-foreground"
              >
                {skip.title ?? skip.sessionId} ({label(skip.ownerEnvironmentId)}): {skip.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Each linked machine's own sessions, opened read-only through the link without a copy. */
function LinkedSessions(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const { environmentId } = props;
  const links = useEnvironmentQuery(peerLinkEnvironment.names({ environmentId, input: {} }));
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const [query, setQuery] = useState("");
  const linkId = selected ?? links.data?.links[0]?.environmentId ?? null;
  const sessions = useEnvironmentQuery(
    linkId === null
      ? null
      : claudeReplicationEnvironment.remoteSessions({
          environmentId,
          input: { environmentId: linkId, ...(query === "" ? {} : { query }) },
        }),
  );
  const linkLabel = links.data?.links.find((link) => link.environmentId === linkId)?.label ?? "";
  if (links.data === null || links.data.links.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-sm">
      <p className="font-medium">
        <T>Sessions on linked machines</T>
      </p>
      <div className="flex flex-wrap gap-2">
        {links.data.links.map((link) => (
          <Button
            key={link.environmentId}
            size="xs"
            variant={link.environmentId === linkId ? "secondary" : "ghost"}
            onClick={() => setSelected(link.environmentId)}
          >
            {link.label}
          </Button>
        ))}
        <DraftInput
          size="sm"
          className="w-full sm:w-56"
          value={query}
          onCommit={setQuery}
          placeholder={gt("Search title or folder")}
          aria-label={gt("Search sessions on the linked machine")}
        />
      </div>
      {sessions.error !== null ? <p className="text-destructive">{sessions.error}</p> : null}
      <ul className="flex flex-col gap-1">
        {(sessions.data?.sessions ?? []).map((session) => (
          <li key={session.sessionId} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate">
              {session.title ?? session.sessionId}
              <span className="ml-2 text-muted-foreground">{session.cwd}</span>
            </span>
            {session.threadId === null || linkId === null ? null : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (session.threadId === null) return;
                  openLinkedThreadRead({
                    panelRef: null,
                    target: {
                      viaEnvironmentId: environmentId,
                      environmentId: linkId,
                      threadId: session.threadId,
                      label: linkLabel,
                      title: session.title,
                    },
                    intent: "primary",
                    navigate,
                  });
                }}
              >
                <T>Open</T>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
