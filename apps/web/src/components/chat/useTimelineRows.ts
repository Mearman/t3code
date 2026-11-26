import { useLocale, useMessages } from "gt-react";
import { useState } from "react";
import type { RunId } from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  handoffRunsSignature,
  type MessagesTimelineRowsInput,
  sameRowsInput,
  deriveMessagesTimelineRowsWithState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { type HandoffTimelineRun } from "./V2LifecycleRow";

const EMPTY_TIMELINE_RUNS: ReadonlyArray<HandoffTimelineRun> = [];

export function useStableHandoffRuns(
  runs: ReadonlyArray<HandoffTimelineRun>,
): ReadonlyArray<HandoffTimelineRun> {
  const [state, setState] = useState<{
    readonly source: ReadonlyArray<HandoffTimelineRun> | null;
    readonly signature: string;
    readonly value: ReadonlyArray<HandoffTimelineRun>;
  }>({ source: null, signature: "", value: EMPTY_TIMELINE_RUNS });
  if (state.source === runs) return state.value;
  const signature = handoffRunsSignature(runs);
  const value =
    signature === state.signature
      ? state.value
      : runs.map((run) => ({
          id: run.id,
          ordinal: run.ordinal,
          providerInstanceId: run.providerInstanceId,
          modelSelection: run.modelSelection,
        }));
  setState({ source: runs, signature, value });
  return value;
}

/**
 * Rows derived from the previous projection of the same list, so a streamed
 * text update patches its message rows instead of deriving every row again.
 */
export function useIncrementalTimelineRows(
  identity: string,
  input: MessagesTimelineRowsInput,
): MessagesTimelineRow[] {
  // Keyed on the locale: without a GTProvider, useMessages() returns a new function every render.
  const locale = useLocale();
  const resolve = useMessages();
  const [state, setState] = useState(() => ({
    identity,
    input,
    locale,
    projection: deriveMessagesTimelineRowsWithState(input, null, resolve),
  }));
  const reusable = state.identity === identity && state.locale === locale;
  if (reusable && sameRowsInput(state.input, input)) {
    return state.projection.rows;
  }
  const projection = deriveMessagesTimelineRowsWithState(
    input,
    reusable ? state.projection : null,
    resolve,
  );
  setState({ identity, input, locale, projection });
  return projection.rows;
}

export function useStableRows(
  rows: MessagesTimelineRow[],
  identity: string,
): MessagesTimelineRow[] {
  const [state, setState] = useState<{
    readonly identity: string;
    readonly source: MessagesTimelineRow[] | null;
    readonly stable: StableMessagesTimelineRowsState;
  }>({ identity, source: null, stable: { byId: new Map(), result: [] } });
  if (state.identity === identity && state.source === rows) return state.stable.result;
  const stable = computeStableMessagesTimelineRows(
    rows,
    state.identity === identity ? state.stable : { byId: new Map(), result: [] },
  );
  setState({ identity, source: rows, stable });
  return stable.result;
}

const EMPTY_RUN_ID_SET: ReadonlySet<RunId> = new Set();

/** The same set until its members change, so shared row context does not re-render every row. */
export function useStableRunIdSet(runIds: ReadonlyArray<RunId>): ReadonlySet<RunId> {
  const signature = runIds.join("\u0000");
  const [state, setState] = useState<{
    readonly signature: string;
    readonly value: ReadonlySet<RunId>;
  }>({ signature: "", value: EMPTY_RUN_ID_SET });
  if (state.signature === signature) return state.value;
  const value = new Set(runIds);
  setState({ signature, value });
  return value;
}
