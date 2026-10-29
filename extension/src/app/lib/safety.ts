// Destructive-statement check for production connections (DESIGN.md §3.13).
// A light tokenizer: strips comments and string literals, then splits on ';'.

export interface Destructive {
  kind: "drop" | "truncate" | "delete_all" | "update_all" | "alter_mutation";
  /** Name the user must type to confirm. */
  target: string;
  statement: string;
}

export function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "''");
}

export function splitStatements(sql: string): string[] {
  return stripSql(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const IDENT = String.raw`((?:[\`"]?[\w$.-]+[\`"]?)(?:\s*\.\s*[\`"]?[\w$.-]+[\`"]?)*)`;
const unquote = (s: string) => s.replace(/[`"\s]/g, "");

export function findDestructive(sql: string): Destructive[] {
  const out: Destructive[] = [];
  for (const stmt of splitStatements(sql)) {
    const s = stmt.replace(/\s+/g, " ");
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^drop\\s+(?:table|view|schema|database|materialized view|dictionary|index)\\s+(?:if exists\\s+)?${IDENT}`, "i").exec(s))) {
      out.push({ kind: "drop", target: unquote(m[1]!), statement: stmt });
    } else if ((m = new RegExp(`^truncate\\s+(?:table\\s+)?(?:if exists\\s+)?${IDENT}`, "i").exec(s))) {
      out.push({ kind: "truncate", target: unquote(m[1]!), statement: stmt });
    } else if ((m = new RegExp(`^delete\\s+from\\s+${IDENT}`, "i").exec(s)) && !/\bwhere\b/i.test(s)) {
      out.push({ kind: "delete_all", target: unquote(m[1]!), statement: stmt });
    } else if ((m = new RegExp(`^update\\s+${IDENT}\\s+set\\b`, "i").exec(s)) && !/\bwhere\b/i.test(s)) {
      out.push({ kind: "update_all", target: unquote(m[1]!), statement: stmt });
    } else if ((m = new RegExp(`^alter\\s+table\\s+${IDENT}.*\\b(delete|update)\\b`, "i").exec(s))) {
      out.push({ kind: "alter_mutation", target: unquote(m[1]!), statement: stmt });
    }
  }
  return out;
}

/** Statements that change data or schema; blocked in read-only mode as a UI hint (drivers enforce it). */
export function isWriteStatement(sql: string): boolean {
  return splitStatements(sql).some((s) =>
    /^(insert|update|delete|merge|upsert|replace|create|drop|alter|truncate|grant|revoke|rename|optimize|attach|detach|copy|vacuum)\b/i.test(s),
  );
}
