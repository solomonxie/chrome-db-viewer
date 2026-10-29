// Classifies source type names (int8, Nullable(UInt64), STRING, jsonb …) for editors and filters.

export function baseType(type: string): string {
  let t = type.trim().toLowerCase();
  for (;;) {
    const m = /^(nullable|lowcardinality)\((.*)\)$/.exec(t);
    if (!m) break;
    t = m[2]!;
  }
  return t.replace(/\(.*\)$/, "").trim();
}

const NUMERIC = /^(u?int\d*|tinyint|smallint|mediumint|bigint|integer|int|hugeint|uhugeint|float\d*|double( precision)?|decimal\d*|numeric|bignumeric|real|number|serial|bigserial|smallserial|money)$/;

export const isNumericType = (t: string) => NUMERIC.test(baseType(t));
export const isBoolType = (t: string) => /^(bool|boolean)$/.test(baseType(t));
export const isJsonType = (t: string) => /^(json|jsonb|object|map|struct|variant|record|array|tuple)$/.test(baseType(t)) || /\[\]$/.test(t);
export const isTimeType = (t: string) => /^(timestamp|timestamptz|timestamp with(out)? time zone|datetime|datetime64|date|date32|time|timetz)$/.test(baseType(t));
export const isTextType = (t: string) =>
  /^(text|varchar|character varying|char|character|string|fixedstring|uuid|enum\d*|name|citext|bpchar)$/.test(baseType(t));

/** `"123"` style integer/decimal literal: safe to inline unquoted. */
export const NUMBER_LITERAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
