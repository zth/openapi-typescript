import type { ReferenceObject, SchemaObject } from "../types.js";

export const RES_KEYWORDS = new Set<string>([
  "and",
  "as",
  "assert",
  "begin",
  "class",
  "constraint",
  "do",
  "done",
  "downto",
  "else",
  "end",
  "exception",
  "external",
  "false",
  "for",
  "fun",
  "function",
  "functor",
  "if",
  "in",
  "include",
  "inherit",
  "initializer",
  "lazy",
  "let",
  "method",
  "module",
  "mutable",
  "new",
  "nonrec",
  "object",
  "of",
  "open",
  "or",
  "private",
  "rec",
  "sig",
  "struct",
  "then",
  "to",
  "true",
  "try",
  "type",
  "val",
  "virtual",
  "when",
  "while",
  "with",
]);

export function indentLines(s: string | string[], spaces = 2): string {
  const pad = " ".repeat(spaces);
  const lines = Array.isArray(s) ? s : s.split("\n");
  return lines.map((l) => (l.length ? pad + l : l)).join("\n");
}

export function sanitizeIdent(base: string): string {
  if (!base) return "_";
  let out = base
    .split("")
    .map((c, i) =>
      i === 0
        ? /[A-Za-z_]/.test(c)
          ? c
          : "_"
        : /[A-Za-z0-9_]/.test(c)
          ? c
          : "_"
    )
    .join("");
  out = out.replace(/_+/g, "_");
  return out;
}

export function toValidTypeName(name: string): string {
  let out = sanitizeIdent(name);
  // ReScript type names should start lowercase
  if (out.length > 0) out = out[0].toLowerCase() + out.slice(1);
  if (/^[0-9]/.test(out)) out = `t_${out}`;
  if (RES_KEYWORDS.has(out)) out = `${out}_`;
  return out;
}

export function toValidResFieldName(name: string): {
  rendered: string;
  attr?: string;
} {
  const raw = /^[0-9]+$/.test(name) ? `s${name}` : sanitizeIdent(name);
  const sanitized = raw.length > 0 ? raw[0]!.toLowerCase() + raw.slice(1) : raw;
  const reserved = RES_KEYWORDS.has(sanitized);
  const finalName = reserved ? `${sanitized}_` : sanitized;
  if (sanitized !== name || reserved) {
    return { rendered: finalName, attr: `@as(${JSON.stringify(name)}) ` };
  }
  return { rendered: finalName };
}

export function wrapBlockDoc(s?: string): string | undefined {
  if (!s) return undefined;
  const body = s.trim();
  if (!body) return undefined;
  // Sanitize nested comment sentinels to keep formatter/parser happy on large contexts
  const safe = body.replace(/\*\//g, "* /").replace(/\/\*/g, "/ *");
  return ["/**", ...safe.split("\n").map((l) => ` * ${l}`), " */"].join("\n");
}

export function refName($ref: string): string | undefined {
  const parts = $ref.split("/");
  const last = parts[parts.length - 1];
  return last ? toValidTypeName(last) : undefined;
}

export type RSContext = {
  alphabetize: boolean;
  excludeDeprecated: boolean;
  silent: boolean;
  /** Resolve a $ref to a concrete value, if possible */
  resolve: <T = unknown>(ref: string) => T | undefined;
  /** Optional: when provided, rsInclude filtering is enabled */
  rsIncludeEnabled?: boolean;
  /** Optional exact path includes (e.g., "/pets") */
  includePaths?: Set<string>;
  /** Optional explicit component schema names to include (raw keys under components.schemas) */
  explicitSchemas?: Set<string>;
  /** Computed transitive closure of component schema names to emit when filtering */
  selectedSchemas?: Set<string>;
};

export type SchemaLike = SchemaObject | ReferenceObject;

export function toValidModuleName(name: string): string {
  let out = sanitizeIdent(name);
  if (out.length === 0) return "M";
  // Ensure starts with a letter; ReScript modules are PascalCase typically
  if (!/[A-Za-z]/.test(out[0]!)) out = `M_${out}`;
  // Capitalize first char
  out = out[0]!.toUpperCase() + out.slice(1);
  if (RES_KEYWORDS.has(out.toLowerCase())) out = `${out}_`;
  return out;
}
