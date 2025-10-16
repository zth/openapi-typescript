import type { } from "../types.js";

// Structured IR for ReScript emission
export type QPath = string[]; // qualified path, e.g. ["Components", "Schemas", "User"]

export type FieldIR = {
  name: string;
  typ: TypeIR;
  // Optional rendering style for object fields.
  // undefined = required, "questionMark" => name?: t, "option" => name: option<t>
  optional?: "questionMark" | "option";
  // Optional inline doc block printed above the field.
  doc?: string;
  // Optional attribute prefix (e.g., @as("json-key") ).
  attr?: string;
};

export type TypeIR =
  | { kind: "raw"; code: string }
  | { kind: "withDoc"; doc: string; inner: TypeIR }
  | { kind: "ref"; path: QPath }
  | { kind: "app"; callee: TypeIR; args: TypeIR[] }
  | { kind: "record"; fields: FieldIR[] }
  | { kind: "poly"; cases: Array<{ label: string; payload?: TypeIR }> }
  | { kind: "adt"; cases: Array<{ label: string; payload?: TypeIR; attr?: string }> }
  | { kind: "tuple"; items: TypeIR[] };

export function raw(code: string): TypeIR {
  return { kind: "raw", code };
}

export function withDoc(doc: string | undefined, inner: TypeIR): TypeIR {
  if (!doc) return inner;
  return { kind: "withDoc", doc, inner };
}

export function ref(path: QPath | string): TypeIR {
  return { kind: "ref", path: Array.isArray(path) ? path : [path] };
}

export function app(callee: TypeIR | string, args: (TypeIR | string)[]): TypeIR {
  const normCallee = typeof callee === "string" ? ref(callee) : callee;
  const normArgs = args.map((a) => (typeof a === "string" ? ref(a) : a));
  return { kind: "app", callee: normCallee, args: normArgs };
}

export function record(fields: FieldIR[]): TypeIR {
  return { kind: "record", fields };
}

export function poly(
  cases: Array<{ label: string; payload?: TypeIR | string }>
): TypeIR {
  return {
    kind: "poly",
    cases: cases.map((c) => ({
      label: c.label,
      payload: typeof c.payload === "string" ? ref(c.payload) : c.payload,
    })),
  };
}

export function tuple(items: (TypeIR | string)[]): TypeIR {
  return { kind: "tuple", items: items.map((i) => (typeof i === "string" ? ref(i) : i)) };
}

export function adt(
  cases: Array<{ label: string; payload?: TypeIR | string; attr?: string }>
): TypeIR {
  return {
    kind: "adt",
    cases: cases.map((c) => ({
      label: c.label,
      attr: c.attr,
      payload: typeof c.payload === "string" ? ref(c.payload) : c.payload,
    })),
  };
}

export type RSNode =
  | { kind: "comment"; code: string }
  | { kind: "attr"; code: string }
  | { kind: "open"; name: string }
  | { kind: "type"; keyword: "type" | "and" | "type rec"; name: string; body: TypeIR }
  | { kind: "raw"; code: string }
  | { kind: "blank" }
  | { kind: "module"; name: string; items: RSNode[] };
