import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { SearchField } from "../../components/ui/SearchField";
import { claudeReplicationEnvironment } from "../../state/claudeReplication";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThreadRead } from "../threads/useOpenLinkedThread";
import { SettingsSection } from "./components/SettingsSection";

const SEARCH_DEBOUNCE_MS = 300;

const formatTime = (time: DateTime.Utc) => new Date(DateTime.toEpochMillis(time)).toLocaleString();

/**
 * One machine's copies of linked machines' Claude sessions, its last pass, and the linked machines'
 * own sessions to open without copying them.
 */
export function ClaudeReplicationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  const { environmentId } = props;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const report = useEnvironmentQuery(
    claudeReplicationEnvironment.report({ environmentId, input: {} }),
  );
  const replicateNow = useAtomCommand(claudeReplicationEnvironment.replicateNow);
  const [copying, setCopying] = useState(false);
  const owners = new Map(
    report.data?.sources.map((source) => [source.environmentId, source.label]),
  );

  return (
    <SettingsSection title={gt("Copies on {machine}", { machine: props.label })}>
      <View className="gap-2 px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {report.data?.lastRunAt != null
            ? gt("Last checked {time}.", { time: formatTime(report.data.lastRunAt) })
            : gt("Not checked yet since this server started.")}
        </Text>
        {report.data?.sources.map((source) => (
          <Text key={source.environmentId} textRole="footnote">
            {source.outcome === "synced"
              ? gt("{machine}: checked", { machine: source.label })
              : source.outcome === "unsupported"
                ? gt("{machine}: does not share sessions", { machine: source.label })
                : source.outcome === "refused"
                  ? gt("{machine}: refused", { machine: source.label })
                  : gt("{machine}: did not answer; its copies are marked stale", {
                      machine: source.label,
                    })}
          </Text>
        ))}
        {report.data?.replicas.map((replica) => (
          <Text
            key={replica.sessionId}
            textRole="footnote"
            className={replica.status === "stale" ? "text-warning" : "text-foreground-muted"}
          >
            {replica.status === "stale"
              ? gt("{session}: stale since {time}, owned by {owner}", {
                  session: replica.title ?? replica.sessionId,
                  time: formatTime(replica.syncedAt),
                  owner: owners.get(replica.ownerEnvironmentId) ?? replica.ownerEnvironmentId,
                })
              : gt("{session}: current at {time}, owned by {owner}", {
                  session: replica.title ?? replica.sessionId,
                  time: formatTime(replica.syncedAt),
                  owner: owners.get(replica.ownerEnvironmentId) ?? replica.ownerEnvironmentId,
                })}
          </Text>
        ))}
        {report.data?.skipped.map((skip) => (
          <Text
            key={`${skip.ownerEnvironmentId}:${skip.sessionId}`}
            textRole="footnote"
            className="text-foreground-muted"
          >
            {gt("Not copied: {session}. {reason}", {
              session: skip.title ?? skip.sessionId,
              reason: skip.message,
            })}
          </Text>
        ))}
        <Button
          label={copying ? gt("Copying…") : gt("Copy now")}
          size="compact"
          disabled={!canOperate || copying}
          onPress={async () => {
            setCopying(true);
            await replicateNow({ environmentId, input: {} });
            setCopying(false);
          }}
        />
      </View>
      <LinkedSessions environmentId={environmentId} />
    </SettingsSection>
  );
}

function LinkedSessions(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { environmentId } = props;
  const openLinkedThread = useOpenLinkedThreadRead();
  const links = useEnvironmentQuery(peerLinkEnvironment.names({ environmentId, input: {} }));
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInputInstance>(null);
  const linkId = selected ?? links.data?.links[0]?.environmentId ?? null;
  // Each listing is a call to the linked machine, so typing settles before one is made.
  const searched = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const sessions = useEnvironmentQuery(
    linkId === null
      ? null
      : claudeReplicationEnvironment.remoteSessions({
          environmentId,
          input: { environmentId: linkId, ...(searched === "" ? {} : { query: searched }) },
        }),
  );
  if (links.data === null || links.data.links.length === 0) return null;
  const linkLabel = links.data.links.find((link) => link.environmentId === linkId)?.label ?? "";
  return (
    <View className="gap-2 px-4 py-3">
      <Text textRole="body">{gt("Sessions on linked machines")}</Text>
      <View className="flex-row flex-wrap gap-2">
        {links.data.links.map((link) => (
          <Chip
            key={link.environmentId}
            size="small"
            label={link.label}
            selected={link.environmentId === linkId}
            onPress={() => setSelected(link.environmentId)}
          />
        ))}
      </View>
      <View className="flex-row">
        <SearchField
          inputRef={searchRef}
          accessibilityLabel={gt("Search sessions on the linked machine")}
          clearAccessibilityLabel={gt("Clear the session search")}
          placeholder={gt("Search title or folder")}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      {sessions.error !== null ? (
        <Text textRole="footnote" className="text-danger">
          {sessions.error}
        </Text>
      ) : null}
      {(sessions.data?.sessions ?? []).map((session) =>
        session.threadId === null || linkId === null ? null : (
          <Button
            key={session.sessionId}
            tone="text"
            size="compact"
            label={session.title ?? session.sessionId}
            accessibilityHint={gt("Opens the session on {machine} without copying it", {
              machine: linkLabel,
            })}
            onPress={() => {
              if (session.threadId === null) return;
              openLinkedThread(
                { environmentId: linkId, threadId: session.threadId },
                { viaEnvironmentId: environmentId, label: linkLabel },
                session.title,
              );
            }}
          />
        ),
      )}
    </View>
  );
}
