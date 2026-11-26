import type { RunOrigin } from "@t3tools/shared/orchestrationV2ThreadError";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The condition that says which runs a subquery picking one run by order reads, as `runsByOrigin` does in code; it appends to the subquery's conditions. `alias` is null for a subquery that names no alias. The `t3code/explicit-run-origin` lint rule asks for a call to it in every such subquery.
 */
export const runOriginSql = (sql: SqlClient.SqlClient, alias: string | null, origin: RunOrigin) => {
  if (origin === "any") return sql``;
  const payload = sql.literal(alias === null ? "payload_json" : `${alias}.payload_json`);
  return sql`AND json_extract(${payload}, '$.nativeOrigin') IS NULL`;
};
