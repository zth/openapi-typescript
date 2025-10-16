import type { } from "../types.js";

// Minimal IR for ReScript emission
export type TypeIR =
  | { kind: "raw"; code: string }
  | { kind: "withDoc"; doc: string; inner: TypeIR };

export function raw(code: string): TypeIR {
  return { kind: "raw", code };
}

export function withDoc(doc: string | undefined, inner: TypeIR): TypeIR {
  if (!doc) return inner;
  return { kind: "withDoc", doc, inner };
}

export type RSNode =
  | { kind: "comment"; code: string }
  | { kind: "attr"; code: string }
  | { kind: "open"; name: string }
  | { kind: "type"; keyword: "type" | "and" | "type rec"; name: string; body: TypeIR }
  | { kind: "raw"; code: string }
  | { kind: "blank" }
  | { kind: "module"; name: string; items: RSNode[] };

