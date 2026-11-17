// BigQuery scripting: a DECLARE'd variable (and SET, a temp function) lives only inside one
// script job. Splitting the editor text at ';' into separate jobs loses it ("Unrecognized name:
// end_date"), so on BigQuery the setup statements are sent together with the query they serve.

import { splitStatementsRaw as splitStatements } from "./split";

const SETUP = /^(?:DECLARE|SET|CREATE\s+(?:OR\s+REPLACE\s+)?TEMP(?:ORARY)?\s+(?:FUNCTION|TABLE))\b/i;

/** First keyword(s) after leading comments. */
function head(stmt: string): string {
  return stmt.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "");
}

/** DECLARE, SET or CREATE TEMP FUNCTION/TABLE: a statement later ones in the script depend on. */
export function isScriptSetup(stmt: string): boolean {
  return SETUP.test(head(stmt));
}

/** True when the statements only make sense run as one BigQuery script. */
export function needsScript(statements: string[]): boolean {
  return statements.length > 1 && statements.some(isScriptSetup);
}

/**
 * What Run sends for the statement at `index`: the setup statements before it plus the
 * statement itself, as one script. Just the statement when nothing before it is setup, or
 * when it is setup itself.
 */
export function scriptFor(statements: string[], index: number): string {
  const stmt = statements[index]!;
  if (isScriptSetup(stmt)) return stmt;
  const setup = statements.slice(0, index).filter(isScriptSetup);
  return [...setup, stmt].join(";\n");
}

/** The whole text as one script (Run all, the dry run). */
export function asScript(statements: string[]): string {
  return statements.join(";\n");
}

/** One statement that is itself a script (setup statements and a query joined). */
export function isWholeScript(statements: string[]): boolean {
  return statements.length === 1 && needsScript(splitStatements(statements[0]!));
}

/** More than one statement that isn't setup: worth a result tab each. */
export function scriptReturnsSeveral(statements: string[]): boolean {
  return statements.filter((x) => !isScriptSetup(x)).length > 1;
}
