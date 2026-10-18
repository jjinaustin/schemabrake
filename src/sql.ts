import { parse } from "libpg-query";

/** One top-level statement from a migration file, with its position in the source. */
export interface Statement {
  /** The statement's node type, e.g. "IndexStmt", "AlterTableStmt". */
  kind: string;
  /** The node body (the value under `kind`). */
  node: any;
  /** 1-based line of the first non-comment character of the statement. */
  line: number;
  /**
   * Byte offset in the file of the text this statement was parsed from. Node `location`s are
   * relative to that text, so a node's file offset is `origin + location`. Zero except for
   * statements unwrapped from a DO block.
   */
  origin: number;
  /** Statement text without leading whitespace and comments. */
  text: string;
  /** Comments that precede the statement (where ignore directives live). */
  leadingComments: string;
}

export class SqlParseError extends Error {
  constructor(message: string, readonly line: number | undefined) {
    super(message);
  }
}

/**
 * Parses a migration file with PostgreSQL's own parser (libpg_query, compiled to WASM).
 * No database connection is involved.
 *
 * libpg_query reports positions as UTF-8 byte offsets, so all slicing happens on bytes;
 * a comment containing non-ASCII characters would otherwise shift every line number after it.
 */
export async function parseStatements(sql: string, within?: { file: Buffer; origin: number }): Promise<Statement[]> {
  const bytes = Buffer.from(sql, "utf8");
  const file = within?.file ?? bytes;
  const origin = within?.origin ?? 0;
  let tree: any;
  try {
    tree = await parse(sql);
  } catch (err: any) {
    const pos = err?.sqlDetails?.cursorPosition;
    throw new SqlParseError(err?.message ?? String(err), typeof pos === "number" ? lineAtByte(file, origin + pos) : undefined);
  }

  const out: Statement[] = [];
  for (const raw of tree.stmts ?? []) {
    const start: number = raw.stmt_location ?? 0;
    // stmt_len is omitted (0) for the last statement when it has no trailing semicolon.
    const end: number = raw.stmt_len ? start + raw.stmt_len : bytes.length;
    const chunk = bytes.subarray(start, end).toString("utf8");
    const bodyAt = skipLeadingTrivia(chunk);
    const kind = Object.keys(raw.stmt)[0];
    out.push({
      kind,
      node: raw.stmt[kind],
      line: lineAtByte(file, origin + start) + countNewlines(chunk.slice(0, bodyAt)),
      origin,
      text: chunk.slice(bodyAt),
      leadingComments: chunk.slice(0, bodyAt),
    });
  }
  return out;
}

const DO_BODY = /^\s*BEGIN\b(?<sql>[\s\S]*?)(?:\bEXCEPTION\b[\s\S]*)?\bEND\s*;?\s*$/i;

/**
 * The SQL inside a `DO $$ BEGIN ... [EXCEPTION ...] END $$` block, as top-level statements.
 *
 * libpg_query cannot parse PL/pgSQL, but Drizzle wraps every foreign key in exactly this shape
 * (with `EXCEPTION WHEN duplicate_object THEN null`), and those statements lock tables like any
 * other. Bodies with control flow, variables or dynamic SQL fail to parse as plain SQL and are
 * returned as an empty list, so they stay unchecked rather than misread.
 */
export async function unwrapDoBlock(stmt: Statement, file: Buffer): Promise<Statement[]> {
  if (stmt.kind !== "DoStmt") return [];
  const args = (stmt.node.args ?? []).map((a: any) => a.DefElem);
  const language = args.find((a: any) => a.defname === "language")?.arg?.String?.sval;
  const as = args.find((a: any) => a.defname === "as");
  if ((language && language.toLowerCase() !== "plpgsql") || typeof as?.arg?.String?.sval !== "string") return [];

  // `location` points at the opening dollar quote; single-quoted bodies have escapes that would
  // shift every offset, so only dollar-quoted ones are unwrapped.
  const at = stmt.origin + as.location;
  const quote = /^\$[A-Za-z_0-9]*\$/.exec(file.subarray(at, at + 64).toString("utf8"))?.[0];
  if (!quote) return [];
  const body: string = as.arg.String.sval;
  const m = DO_BODY.exec(body);
  if (!m?.groups?.sql.trim()) return [];
  const sqlStart = body.search(/BEGIN/i) + "BEGIN".length;
  try {
    const inner = await parseStatements(m.groups.sql, {
      file,
      origin: at + Buffer.byteLength(quote) + Buffer.byteLength(body.slice(0, sqlStart)),
    });
    return inner.map((s) => ({ ...s, leadingComments: stmt.leadingComments + s.leadingComments }));
  } catch {
    return [];
  }
}

/** 1-based line containing the given UTF-8 byte offset. */
export function lineAtByte(bytes: Buffer, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

function countNewlines(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "\n") n++;
  return n;
}

/** Index of the first character that is not whitespace, a `--` comment or a block comment. */
function skipLeadingTrivia(s: string): number {
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) i++;
    else if (s.startsWith("--", i)) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
    } else if (s.startsWith("/*", i)) {
      const close = s.indexOf("*/", i + 2);
      i = close === -1 ? s.length : close + 2;
    } else break;
  }
  return i;
}
