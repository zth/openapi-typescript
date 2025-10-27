import { COMMENT_HEADER } from "../index.js";
import { getEntries } from "../lib/utils.js";
import type {
  ComponentsObject,
  OpenAPI3,
  ReferenceObject,
  SchemaObject,
  PathsObject,
  PathItemObject,
  OperationObject,
  RequestBodyObject,
  ResponseObject,
  DiscriminatorObject,
  HeaderObject,
  MediaTypeObject,
  ArraySubtype,
  ObjectSubtype,
  $defs,
  CallbackObject,
} from "../types.js";
import type { RSContext, SchemaLike } from "./utils.js";
import {
  RES_KEYWORDS,
  indentLines,
  refName,
  toValidModuleName,
  toValidResFieldName,
  toValidTypeName,
  wrapBlockDoc,
} from "./utils.js";
import type { RSNode, TypeIR, FieldIR } from "./ir.js";
import { raw as rawIR, withDoc, ref as refIR, app as appIR, record as recordIR, poly as polyIR, adt as adtIR } from "./ir.js";
import { printFile, printTypeIR } from "./printer.js";

// ReScript emitter for Operations, Callbacks and Components

// --- rsInclude support: dependency walker and selection helpers ---
function isSchemaRefToComponent(ref: string): { ok: true; name: string } | { ok: false } {
  const m = ref.match(/#\/components\/schemas\/([^/#]+)$/);
  return m ? { ok: true, name: m[1]! } : { ok: false };
}

function collectSchemaRefs(schema: SchemaLike | undefined, ctx: RSContext, add: (name: string) => void, seen: Set<object>): void {
  if (!schema) return;
  if (isRef(schema)) {
    const r = schema.$ref;
    const mm = typeof r === "string" ? isSchemaRefToComponent(r) : { ok: false } as const;
    if (mm.ok) add(mm.name);
    const resolved = ctx.resolve<SchemaObject>(r as string);
    if (resolved && typeof resolved === "object") collectSchemaRefs(resolved, ctx, add, seen);
    return;
  }
  const s = schema as SchemaObject;
  if (!s || typeof s !== "object") return;
  if (seen.has(s as object)) return;
  seen.add(s as object);
  // composition
  if (Array.isArray((s as any).allOf)) (s as any).allOf.forEach((m: SchemaLike) => collectSchemaRefs(m, ctx, add, seen));
  if (Array.isArray((s as any).oneOf)) (s as any).oneOf.forEach((m: SchemaLike) => collectSchemaRefs(m, ctx, add, seen));
  if (Array.isArray((s as any).anyOf)) (s as any).anyOf.forEach((m: SchemaLike) => collectSchemaRefs(m, ctx, add, seen));
  if ((s as any).not) collectSchemaRefs((s as any).not, ctx, add, seen);
  // arrays / tuples
  const items = (s as any).items;
  if (items) {
    if (Array.isArray(items)) items.forEach((m: SchemaLike) => collectSchemaRefs(m, ctx, add, seen));
    else collectSchemaRefs(items as SchemaLike, ctx, add, seen);
  }
  const prefixItems = (s as any).prefixItems;
  if (Array.isArray(prefixItems)) prefixItems.forEach((m: SchemaLike) => collectSchemaRefs(m, ctx, add, seen));
  // objects
  const props = (s as any).properties as Record<string, SchemaLike> | undefined;
  if (props && typeof props === "object")
    for (const v of Object.values(props)) collectSchemaRefs(v, ctx, add, seen);
  const addl = (s as any).additionalProperties as boolean | SchemaLike | undefined;
  if (addl && typeof addl === "object") collectSchemaRefs(addl as SchemaLike, ctx, add, seen);
  const patt = (s as any).patternProperties as Record<string, SchemaLike> | undefined;
  if (patt && typeof patt === "object") for (const v of Object.values(patt)) collectSchemaRefs(v, ctx, add, seen);
  // conditional
  if ((s as any).if) collectSchemaRefs((s as any).if, ctx, add, seen);
  if ((s as any).then) collectSchemaRefs((s as any).then, ctx, add, seen);
  if ((s as any).else) collectSchemaRefs((s as any).else, ctx, add, seen);
}

function collectFromParameter(param: import("../types.js").ParameterObject | undefined, ctx: RSContext, add: (name: string) => void, seen: Set<object>) {
  if (!param) return;
  if (param.schema) collectSchemaRefs(param.schema as SchemaLike, ctx, add, seen);
  if (param.content && typeof param.content === "object") {
    for (const mt of Object.values(param.content)) {
      const mtResolved = isRef(mt as any) ? ctx.resolve<import("../types.js").MediaTypeObject>((mt as any).$ref) : (mt as any);
      if (mtResolved && typeof mtResolved === "object" && (mtResolved as any).schema)
        collectSchemaRefs((mtResolved as any).schema, ctx, add, seen);
    }
  }
}

function collectFromOperation(op: OperationObject | undefined, ctx: RSContext, add: (name: string) => void, seen: Set<object>) {
  if (!op) return;
  // parameters
  const opParams = op.parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
  if (Array.isArray(opParams)) {
    for (const p of opParams) {
      const pr = isRef(p) ? ctx.resolve<import("../types.js").ParameterObject>(p.$ref) : (p as any);
      if (pr) collectFromParameter(pr, ctx, add, seen);
    }
  }
  // request body
  const rb = op.requestBody;
  if (rb) {
    const req = isRef(rb) ? ctx.resolve<RequestBodyObject>(rb.$ref) : (rb as any);
    const content = req && (req as any).content && typeof (req as any).content === "object" ? (req as any).content : undefined;
    if (content) {
      for (const mt of Object.values(content)) {
        const mtResolved = isRef(mt as any) ? ctx.resolve<import("../types.js").MediaTypeObject>((mt as any).$ref) : (mt as any);
        if (mtResolved && typeof mtResolved === "object" && (mtResolved as any).schema)
          collectSchemaRefs((mtResolved as any).schema, ctx, add, seen);
      }
    }
  }
  // responses (all statuses and default)
  const resps = op.responses as import("../types.js").ResponsesObject | undefined;
  if (resps && typeof resps === "object") {
    for (const rv of Object.values(resps)) {
      const resp = isRef(rv as any) ? ctx.resolve<ResponseObject>((rv as any).$ref) : (rv as any);
      if (!resp || typeof resp !== "object") continue;
      // content
      const content = (resp as any).content;
      if (content && typeof content === "object") {
        for (const mt of Object.values(content)) {
          const mtResolved = isRef(mt as any) ? ctx.resolve<import("../types.js").MediaTypeObject>((mt as any).$ref) : (mt as any);
          if (mtResolved && typeof mtResolved === "object" && (mtResolved as any).schema)
            collectSchemaRefs((mtResolved as any).schema, ctx, add, seen);
        }
      }
      // headers (schemas or content)
      const headers = (resp as any).headers;
      if (headers && typeof headers === "object") {
        for (const h of Object.values(headers as Record<string, HeaderObject | ReferenceObject>)) {
          const hdr = isRef(h as any) ? ctx.resolve<HeaderObject>((h as any).$ref) : (h as any);
          if (!hdr || typeof hdr !== "object") continue;
          if ((hdr as any).schema) collectSchemaRefs((hdr as any).schema, ctx, add, seen);
          const hContent = (hdr as any).content;
          if (hContent && typeof hContent === "object") {
            for (const mt of Object.values(hContent as Record<string, import("../types.js").MediaTypeObject | ReferenceObject>)) {
              const mtResolved = isRef(mt as any) ? ctx.resolve<import("../types.js").MediaTypeObject>((mt as any).$ref) : (mt as any);
              if (mtResolved && typeof mtResolved === "object" && (mtResolved as any).schema)
                collectSchemaRefs((mtResolved as any).schema, ctx, add, seen);
            }
          }
        }
      }
    }
  }
  // callbacks under this operation
  const cbs = op.callbacks as Record<string, CallbackObject | ReferenceObject> | undefined;
  if (cbs && typeof cbs === "object") {
    for (const cb of Object.values(cbs)) {
      const cbResolved = isRef(cb as any) ? ctx.resolve<CallbackObject>((cb as any).$ref) : (cb as any);
      if (!cbResolved || typeof cbResolved !== "object") continue;
      for (const cbPathItemLike of Object.values(cbResolved)) {
        const cbItem = isRef(cbPathItemLike as any)
          ? ctx.resolve<PathItemObject>((cbPathItemLike as any).$ref)
          : (cbPathItemLike as any);
        if (!cbItem || typeof cbItem !== "object") continue;
        // path-level params for callback
        const cbParams = (cbItem as any).parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
        if (Array.isArray(cbParams)) {
          for (const p of cbParams) {
            const pr = isRef(p) ? ctx.resolve<import("../types.js").ParameterObject>(p.$ref) : (p as any);
            if (pr) collectFromParameter(pr, ctx, add, seen);
          }
        }
        const METHODS: (keyof PathItemObject)[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
        for (const m of METHODS) {
          const op2 = resolveOperation((cbItem as any)[m], ctx);
          if (op2) collectFromOperation(op2, ctx, add, seen);
        }
      }
    }
  }
}

function pathIsIncluded(p: string, ctx: RSContext): boolean {
  const exact = ctx.includePaths;
  const prefixes = ctx.includePathPrefixes;
  if (exact && exact.size > 0 && exact.has(p)) return true;
  if (prefixes && prefixes.size > 0) {
    for (const pref of prefixes) {
      if (p === pref) return true;
      if (pref.endsWith("/")) {
        if (p.startsWith(pref)) return true;
      } else {
        if (p.startsWith(pref + "/")) return true;
      }
    }
  }
  return false;
}

function computeSelectedSchemas(schema: OpenAPI3, ctx: RSContext): Set<string> | undefined {
  const includePaths = ctx.includePaths;
  const includePrefixes = ctx.includePathPrefixes;
  const explicit = ctx.explicitSchemas;
  const enabled = (!!includePaths && includePaths.size > 0) || (!!includePrefixes && includePrefixes.size > 0) || (!!explicit && explicit.size > 0);
  if (!enabled) return undefined;
  const selected = new Set<string>();
  const add = (name: string) => {
    if (typeof name === "string" && name.length > 0) selected.add(name);
  };
  const seen = new Set<object>();
  if ((includePaths || includePrefixes) && schema.paths && typeof schema.paths === "object") {
    for (const [p, item] of Object.entries(schema.paths)) {
      if (!pathIsIncluded(p, ctx)) continue;
      const pathItem = isRef(item) ? ctx.resolve<PathItemObject>((item as any).$ref) : (item as any);
      if (!pathItem || typeof pathItem !== "object") continue;
      // path-level params
      const pathParams = (pathItem as any).parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
      if (Array.isArray(pathParams)) {
        for (const par of pathParams) {
          const resolved = isRef(par) ? ctx.resolve<import("../types.js").ParameterObject>(par.$ref) : (par as any);
          if (resolved) collectFromParameter(resolved, ctx, add, seen);
        }
      }
      const METHODS: (keyof PathItemObject)[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
      for (const m of METHODS) {
        const op = resolveOperation((pathItem as any)[m], ctx);
        if (op) collectFromOperation(op, ctx, add, seen);
      }
    }
  }
  if (explicit && explicit.size > 0) for (const nm of explicit) selected.add(nm);
  return selected;
}

// Track component schema type names to qualify refs in Operations/Callbacks
let COMPONENT_SCHEMA_NAMES: Set<string> = new Set();

// Aux type naming: allocate location-based names and add numeric suffixes only
// when a true collision (same base, different body) occurs, and dedupe when the
// same base/body is requested again. Allocation is per-scope (Components.Schemas
// module, or one operation module), managed via CURRENT_AUX_SCOPE.
type AuxScope = {
  usedNames: Set<string>; // all names already allocated in this scope
  nameToBody: Map<string, string>; // name -> normalized body string
};
let CURRENT_AUX_SCOPE: AuxScope | undefined;
function withAuxScope<T>(initialUsed: Iterable<string> | undefined, fn: () => T): T {
  const prev = CURRENT_AUX_SCOPE;
  CURRENT_AUX_SCOPE = { usedNames: new Set(initialUsed ?? []), nameToBody: new Map() };
  try {
    return fn();
  } finally {
    CURRENT_AUX_SCOPE = prev;
  }
}
function registerUsedTypeName(name: string): void {
  if (CURRENT_AUX_SCOPE) CURRENT_AUX_SCOPE.usedNames.add(name);
}

function qualifyComponentRefsIR(t: TypeIR): TypeIR {
  const visit = (node: TypeIR): TypeIR => {
    switch (node.kind) {
      case "raw": {
        const id = node.code.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id) && COMPONENT_SCHEMA_NAMES.has(id)) {
          return { kind: "ref", path: ["Components", "Schemas", id] };
        }
        return node;
      }
      case "withDoc":
        return { kind: "withDoc", doc: node.doc, inner: visit(node.inner) };
      case "ref": {
        const p = node.path;
        if (p.length === 1 && COMPONENT_SCHEMA_NAMES.has(p[0]!)) {
          return { kind: "ref", path: ["Components", "Schemas", p[0]!] };
        }
        return node;
      }
      case "app":
        return { kind: "app", callee: visit(node.callee), args: node.args.map(visit) };
      case "record":
        return { kind: "record", fields: node.fields.map((f) => ({ ...f, typ: visit(f.typ) })) };
      case "poly":
        return { kind: "poly", cases: node.cases.map((c) => (c.payload ? { ...c, payload: visit(c.payload) } : c)) };
      case "adt":
        return { kind: "adt", cases: node.cases.map((c) => (c.payload ? { ...c, payload: visit(c.payload) } : c)) };
      case "tuple":
        return { kind: "tuple", items: node.items.map(visit) };
      default:
        return node;
    }
  };
  return visit(t);
}

// Conservative string-level fallback: qualify bare component type identifiers
// inside already-printed type bodies. This is used when aux types are collected
// as strings (e.g., during hoisting), to ensure operation-local aux records
// properly reference Components.Schemas.<Name> even if a path missed the IR pass.
function qualifyComponentRefsPrinted(printed: string): string {
  try {
    if (!printed || typeof printed !== "string") return printed;
    const names = Array.from(COMPONENT_SCHEMA_NAMES?.values?.() ?? []);
    if (!names || names.length === 0) return printed;
    // Sort longer names first to reduce partial replacements
    names.sort((a, b) => b.length - a.length);
    const lines = printed.split(/\n/);
    const outLines = lines.map((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return line; // no field separator; skip (docs/aliases)
      const left = line.slice(0, idx + 1);
      let right = line.slice(idx + 1);
      for (const nm of names) {
        const re = new RegExp(`(^|[<,\\s\\(\\)\\[\\{])(${nm})(?=\\b)`, "g");
        right = right.replace(re, (_m, pre, id) => `${pre}Components.Schemas.${id}`);
      }
      return left + right;
    });
    return outLines.join("\n");
  } catch (_) {
    return printed;
  }
}

function hasDefs(s: SchemaObject): s is SchemaObject & { $defs: $defs } {
  return "$defs" in s && s.$defs != null && typeof s.$defs === "object";
}

function isArraySchema(s: SchemaObject): s is SchemaObject & ArraySubtype {
  return typeof s.type === "string" && s.type === "array";
}

function isObjectSchema(s: SchemaObject): s is SchemaObject & ObjectSubtype {
  return (
    (typeof s.type === "string" && s.type === "object") ||
    "properties" in s ||
    "additionalProperties" in s
  );
}

function isRef(s: unknown): s is ReferenceObject {
  return (
    !!s &&
    typeof s === "object" &&
    "$ref" in s &&
    typeof (s as { $ref?: unknown }).$ref === "string"
  );
}

// --- Simple untagged union detection for outputs ---
type SimpleUnionMember = {
  schema: SchemaObject;
  refName?: string;
  // direct properties map and required set for detection
  properties: Record<string, SchemaLike>;
  required: Set<string>;
  // literal markers (prop -> stringified literal)
  literalMarkers: Map<string, string>;
  // properties considered non-nullable
  nonNullableProps: Set<string>;
};

type SimpleUnionDetection = {
  ok: true;
  // signals indexed by member position
  signals: Array<
    | { kind: "literal"; prop: string; value: string }
    | { kind: "key"; prop: string }
  >;
  // suggested constructor labels per member (deduped)
  labels: string[];
  // whether Unknown(JSON.t) should be emitted for decoder no-match cases
  allowUnknown: boolean;
} | { ok: false; reason?: string };

function toADTCtorLabel(base: string, used: Set<string>): string {
  const pas = toValidModuleName(base);
  let out = pas;
  let i = 2;
  while (used.has(out)) out = `${pas}_${i++}`;
  used.add(out);
  return out;
}

function resolveObjectLikeForDetection(node: SchemaLike, ctx: RSContext): SchemaObject | undefined {
  const s: SchemaObject | undefined = isRef(node) ? ctx.resolve<SchemaObject>((node as any).$ref) : (node as any);
  if (!s || typeof s !== "object") return undefined;
  // Attempt to descend allOf to find an object-like member (first found)
  const tryInlineObject = (v: SchemaLike | SchemaObject | undefined): SchemaObject | undefined => {
    if (!v) return undefined;
    const n = isRef(v) ? ctx.resolve<SchemaObject>(v.$ref) : (v as any);
    if (!n) return undefined;
    if (Array.isArray((n as any).allOf) && (n as any).allOf.length > 0) {
      for (const m of (n as any).allOf as SchemaLike[]) {
        const k = tryInlineObject(m);
        if (k) return k;
      }
    }
    if (isObjectSchema(n)) return n;
    return undefined;
  };
  return tryInlineObject(s) ?? (isObjectSchema(s) ? s : undefined);
}

function collectMemberInfo(member: SchemaLike, ctx: RSContext): SimpleUnionMember | undefined {
  const s = resolveObjectLikeForDetection(member, ctx);
  if (!s) return undefined;
  const refNm = isRef(member) ? refName(member.$ref) : undefined;
  const props: Record<string, SchemaLike> = ("properties" in s && s.properties) ? (s.properties as Record<string, SchemaLike>) : {};
  const requiredArr = Array.isArray((s as any).required) ? ((s as any).required as string[]) : [];
  const required = new Set<string>(requiredArr);
  const literalMarkers = new Map<string, string>();
  const nonNullable = new Set<string>();
  for (const [k, v] of Object.entries(props)) {
    const node: SchemaObject | undefined = isRef(v) ? ctx.resolve<SchemaObject>((v as any).$ref) : (v as any);
    if (!node) continue;
    // literal marker
    if (node && typeof node === "object") {
      if (Object.prototype.hasOwnProperty.call(node as any, "const") && (node as any).const != null) {
        literalMarkers.set(k, String((node as any).const));
      } else if (Array.isArray((node as any).enum) && (node as any).enum.length === 1) {
        const v0 = (node as any).enum[0];
        if (typeof v0 === "string" || typeof v0 === "number") literalMarkers.set(k, String(v0));
      }
    }
    // non-nullable detection: no explicit null and not nullable
    let nullable = false;
    if ((node as any).nullable === true) nullable = true;
    if (Array.isArray((node as any).type) && (node as any).type.includes("null")) nullable = true;
    if (Array.isArray((node as any).enum) && (node as any).enum.some((x: any) => x == null)) nullable = true;
    if (!nullable) nonNullable.add(k);
  }
  return { schema: s, refName: refNm, properties: props, required, literalMarkers, nonNullableProps: nonNullable };
}

function detectSimpleUntaggedUnion(members: SchemaLike[], ctx: RSContext, discriminator?: DiscriminatorObject): SimpleUnionDetection {
  // Check null members for allowUnknown
  const isNullTypeSchema = (m: SchemaLike | SchemaObject): boolean => {
    let mm: SchemaObject | undefined;
    if (isRef(m)) mm = ctx.resolve<SchemaObject>((m as any).$ref);
    else mm = m as any;
    if (!mm) return false;
    if ((mm as any).type === "null") return true;
    if (Array.isArray((mm as any).type)) {
      const arr = (mm as any).type as unknown[];
      return arr.includes("null") && arr.filter((t) => t !== "null").length === 0;
    }
    if (Array.isArray((mm as any).enum)) return (mm as any).enum.length === 1 && (mm as any).enum[0] == null;
    return false;
  };
  const nonNullMembers = members.filter((m) => !isNullTypeSchema(m));
  if (nonNullMembers.length === 0) return { ok: false, reason: "only null members" };
  const allowUnknown = nonNullMembers.length < members.length;
  // Collect info
  const info: SimpleUnionMember[] = [];
  for (const m of nonNullMembers) {
    const ent = collectMemberInfo(m, ctx);
    if (!ent) return { ok: false, reason: "non-object member" };
    info.push(ent);
  }
  // Gather key usage counts across members
  const keyCounts = new Map<string, number>();
  for (const ent of info) {
    const keys = new Set<string>(Object.keys(ent.properties));
    for (const k of keys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }
  // Literal markers map: prop -> value -> count
  const literalCounts = new Map<string, Map<string, number>>();
  for (const ent of info) {
    for (const [k, v] of ent.literalMarkers.entries()) {
      const mm = literalCounts.get(k) ?? new Map<string, number>();
      mm.set(v, (mm.get(v) ?? 0) + 1);
      literalCounts.set(k, mm);
    }
  }
  const signals: SimpleUnionDetection["signals"] = [];
  const labels: string[] = [];
  const used = new Set<string>();
  for (const ent of info) {
    // prefer discriminator mapping if present
    let labelBase: string | undefined;
    if (discriminator && typeof discriminator === "object" && (discriminator as any).propertyName) {
      const prop = (discriminator as any).propertyName as string;
      const ds = ent.properties[prop];
      const dso: SchemaObject | undefined = ds ? (isRef(ds) ? ctx.resolve<SchemaObject>((ds as any).$ref) : (ds as any)) : undefined;
      const val = dso && ("const" in (dso as any) ? (dso as any).const : Array.isArray((dso as any).enum) && (dso as any).enum.length === 1 ? (dso as any).enum[0] : undefined);
      if (val !== undefined) labelBase = String(val);
    }
    // Choose signal: literal unique across members, or unique non-null key
    let sig: SimpleUnionDetection["signals"][number] | undefined;
    // literal unique
    let litChoice: { prop: string; value: string } | undefined;
    outer: for (const [k, v] of ent.literalMarkers.entries()) {
      const mm = literalCounts.get(k);
      if (mm && (mm.get(v) ?? 0) === 1) { litChoice = { prop: k, value: v }; break outer; }
    }
    if (litChoice) {
      sig = { kind: "literal", prop: litChoice.prop, value: litChoice.value };
      if (!labelBase) labelBase = litChoice.value;
    } else {
      // unique key (present only in this member) and non-nullable
      const keys = Object.keys(ent.properties);
      for (const k of keys) {
        const count = keyCounts.get(k) ?? 0;
        if (count === 1 && ent.nonNullableProps.has(k)) { sig = { kind: "key", prop: k }; if (!labelBase) labelBase = `Has${toValidModuleName(k)}`; break; }
      }
    }
    if (!sig) return { ok: false, reason: "no discriminator signal" };
    signals.push(sig);
    if (!labelBase) labelBase = ent.refName ?? "Member";
    labels.push(toADTCtorLabel(labelBase, used));
  }
  return { ok: true, signals, labels, allowUnknown };
}

function stripLastComma(lines: string[]): string[] {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  const out = [...lines];
  out[out.length - 1] = out[out.length - 1]!.replace(/,\s*$/, "");
  return out;
}

// Strip a leading doc block (/** ... */) if present to simplify body normalization
function stripLeadingDoc(body: string): string {
  let content = body.trimStart();
  if (content.startsWith("/**")) {
    const idx = content.indexOf("*/");
    if (idx >= 0) content = content.slice(idx + 2).trimStart();
  }
  return content.trim();
}

// Allocate an aux type name based on a base. If the base is free in this scope,
// use it. If occupied by an identical body, reuse it. If occupied by a different
// body, append _2, _3, ... until a free or matching slot is found.
function nameWithHash(base: string, body: string): string {
  const scope = CURRENT_AUX_SCOPE;
  const normalized = stripLeadingDoc(body);
  if (!scope) {
    // No scope: best effort, prefer base; only add suffix if already used globally (not tracked).
    return base;
  }
  const used = scope.usedNames;
  const map = scope.nameToBody;
  const existing = map.get(base);
  if (existing != null) {
    if (existing === normalized) return base; // identical shape, reuse
    // find next available numeric suffix with matching or free slot
    let i = 2;
    while (true) {
      const candidate = `${base}_${i}`;
      const prev = map.get(candidate);
      if (prev == null) {
        // free slot
        map.set(candidate, normalized);
        used.add(candidate);
        return candidate;
      }
      if (prev === normalized) return candidate; // identical shape already allocated
      i++;
    }
  } else {
    // base not used yet in the map, but guard against name reserved in scope
    if (!used.has(base)) {
      map.set(base, normalized);
      used.add(base);
      return base;
    }
    // base reserved (by some other declaration); find numeric suffix
    let i = 2;
    while (true) {
      const candidate = `${base}_${i}`;
      if (!used.has(candidate)) {
        map.set(candidate, normalized);
        used.add(candidate);
        return candidate;
      }
      const prev = map.get(candidate);
      if (prev === normalized) return candidate;
      i++;
    }
  }
}

type TypeDeclIR = { name: string; body: TypeIR };

function splitDocBlock(body: string): { doc?: string; code: string } {
  const t = body.trimStart();
  if (t.startsWith("/**")) {
    const i = t.indexOf("*/");
    if (i >= 0) {
      const doc = t.slice(0, i + 2);
      const code = t.slice(i + 2).trimStart();
      return { doc, code };
    }
  }
  return { code: body };
}

// (removed) legacy local printers; all code now builds RS IR and is printed by printer.ts

// Structural equality for a useful subset of TypeIR nodes.
function alphaEq(a: TypeIR, b: TypeIR): boolean {
  if (a === b) return true;
  if (a.kind === "withDoc") return alphaEq(a.inner, b);
  if (b.kind === "withDoc") return alphaEq(a, b.inner);
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "raw": {
      if (b.kind !== "raw") return false;
      return a.code.trim() === b.code.trim();
    }
    case "ref": {
      const bb = b as Extract<TypeIR, { kind: "ref" }>;
      return a.path.join(".") === bb.path.join(".");
    }
    case "app": {
      const bb = b as Extract<TypeIR, { kind: "app" }>;
      if (!alphaEq(a.callee, bb.callee)) return false;
      if (a.args.length !== bb.args.length) return false;
      for (let i = 0; i < a.args.length; i++) if (!alphaEq(a.args[i]!, bb.args[i]!)) return false;
      return true;
    }
    case "record": {
      const bb = b as Extract<TypeIR, { kind: "record" }>;
      if (a.fields.length !== bb.fields.length) return false;
      const af = [...a.fields].map((f) => ({ n: `${f.attr ?? ""}${f.name}`, o: f.optional, t: f.typ })).sort((x, y) => x.n.localeCompare(y.n));
      const bf = [...bb.fields].map((f) => ({ n: `${f.attr ?? ""}${f.name}`, o: f.optional, t: f.typ })).sort((x, y) => x.n.localeCompare(y.n));
      for (let i = 0; i < af.length; i++) {
        if (af[i]!.n !== bf[i]!.n) return false;
        if (af[i]!.o !== bf[i]!.o) return false;
        if (!alphaEq(af[i]!.t, bf[i]!.t)) return false;
      }
      return true;
    }
    case "poly": {
      const bb = b as Extract<TypeIR, { kind: "poly" }>;
      if (a.cases.length !== bb.cases.length) return false;
      const ac = [...a.cases].map((c) => ({ l: c.label, p: c.payload })).sort((x, y) => x.l.localeCompare(y.l));
      const bc = [...bb.cases].map((c) => ({ l: c.label, p: c.payload })).sort((x, y) => x.l.localeCompare(y.l));
      for (let i = 0; i < ac.length; i++) {
        if (ac[i]!.l !== bc[i]!.l) return false;
        const ap = ac[i]!.p;
        const bp = bc[i]!.p;
        if ((ap == null) !== (bp == null)) return false;
        if (ap && bp && !alphaEq(ap, bp)) return false;
      }
      return true;
    }
    case "tuple": {
      const bb = b as Extract<TypeIR, { kind: "tuple" }>;
      if (a.items.length !== bb.items.length) return false;
      for (let i = 0; i < a.items.length; i++) if (!alphaEq(a.items[i]!, bb.items[i]!)) return false;
      return true;
    }
    case "adt": {
      // For now, be conservative; compare printed representations
      return printTypeIR(a) === printTypeIR(b);
    }
  }
}

function pvLabelForValue(v: string): string {
  const isIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  const isReserved = RES_KEYWORDS.has(v);
  return isIdent && !isReserved ? `#${v}` : `#${JSON.stringify(v)}`;
}

function isNullApp(t: TypeIR): t is Extract<TypeIR, { kind: "app" }> {
  return (
    t.kind === "app" &&
    t.callee.kind === "ref" &&
    t.callee.path.join(".") === "Null.t" &&
    Array.isArray(t.args) &&
    t.args.length === 1
  );
}

function unwrapNull(t: TypeIR): TypeIR | undefined {
  if (isNullApp(t)) return t.args[0]!;
  return undefined;
}

// Hoist inline record field types to aux types to reduce nesting and avoid Null.t<{..}>.
function hoistFieldTypeIfNeeded(
  typ: TypeIR,
  collectAux: ((name: string, body: string) => void) | undefined,
  parentName: string | undefined,
  propName: string,
  qualify: boolean = false,
  collectAuxIR?: (name: string, body: TypeIR) => void,
): TypeIR {
  // Unwrap doc wrapper to inspect inner shape
  if (typ.kind === "withDoc") {
    const innerHoisted = hoistFieldTypeIfNeeded(typ.inner, collectAux, parentName, propName, qualify, collectAuxIR);
    if (innerHoisted !== typ.inner) return withDoc(typ.doc, innerHoisted);
    return typ;
  }
  if (typ.kind === "record" && (typeof collectAuxIR === "function" || typeof collectAux === "function")) {
    const baseParent = parentName ?? "t";
    const propBase = toValidTypeName(`${baseParent}_${propName}`);
    // Build a transformed record body where any nested inline records in fields are hoisted
    const prepared = qualify ? qualifyComponentRefsIR(typ) : typ;
    const newFields = prepared.fields.map((f) => {
      const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
      return nt === f.typ ? f : { ...f, typ: nt };
    });
    const nodeRec = recordIR(newFields);
    const printed = printTypeIR(nodeRec);
    const auxName = nameWithHash(propBase, printed);
    if (typeof collectAuxIR === "function") collectAuxIR(auxName, nodeRec);
    else if (typeof collectAux === "function") collectAux(auxName, printed);
    return refIR(auxName);
  }
  if (
    isNullApp(typ) &&
    (typ.args[0]!.kind === "record" || (typ.args[0]!.kind === "withDoc" && (typ.args[0] as any).inner?.kind === "record")) &&
    (typeof collectAuxIR === "function" || typeof collectAux === "function")
  ) {
    const baseParent = parentName ?? "t";
    const propBase = toValidTypeName(`${baseParent}_${propName}`);
    if (typeof collectAuxIR === "function") {
      const arg0 = typ.args[0]! as TypeIR;
      const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
      const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
      const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
      const newFields = prepared.fields.map((f) => {
        const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
        return nt === f.typ ? f : { ...f, typ: nt };
      });
      const recNode = recordIR(newFields);
      const bodyIR = doc ? withDoc(doc, recNode) : recNode;
      const printed = printTypeIR(bodyIR);
      const auxName = nameWithHash(propBase, printed);
      collectAuxIR(auxName, bodyIR);
      return appIR(refIR("Null.t"), [refIR(auxName)]);
    } else {
      const arg0 = typ.args[0]! as TypeIR;
      const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
      const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
      const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
      const newFields = prepared.fields.map((f) => {
        const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
        return nt === f.typ ? f : { ...f, typ: nt };
      });
      let printed = (doc ? `${doc}\n` : "") + printTypeIR(recordIR(newFields));
      if (qualify) printed = qualifyComponentRefsPrinted(printed);
      const auxName = nameWithHash(propBase, printed);
      collectAux(auxName, printed);
      return appIR(refIR("Null.t"), [refIR(auxName)]);
    }
  }
  // Hoist when Null.t wraps an array/dict that itself wraps an inline record
  if (
    isNullApp(typ) &&
    (typeof collectAux === "function" || typeof collectAuxIR === "function") &&
    typ.args[0]!.kind === "app" &&
    typ.args[0]!.callee.kind === "ref" &&
    (isRefNamed(typ.args[0]!.callee, "array") || isRefNamed(typ.args[0]!.callee, "dict"))
  ) {
    const innerApp = typ.args[0]!;
    const innerArg = innerApp.args[0];
    if (innerArg && (innerArg.kind === "record" || (innerArg.kind === "withDoc" && (innerArg as any).inner?.kind === "record"))) {
      const baseParent = parentName ?? "t";
      const propBase = toValidTypeName(`${baseParent}_${propName}`);
      if (typeof collectAuxIR === "function") {
        const arg0 = innerArg as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        const recIRNode = recordIR(newFields);
        const bodyIR = doc ? withDoc(doc, recIRNode) : recIRNode;
        const printed = printTypeIR(bodyIR);
        const auxName = nameWithHash(propBase, printed);
        collectAuxIR(auxName, bodyIR);
        const replacedInner = { kind: "app", callee: innerApp.callee, args: [refIR(auxName)] } as TypeIR;
        return appIR(refIR("Null.t"), [replacedInner]);
      } else {
        const arg0 = innerArg as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        let printed = (doc ? `${doc}\n` : "") + printTypeIR(recordIR(newFields));
        const auxName = nameWithHash(propBase, printed);
        collectAux(auxName, printed);
        const replacedInner = { kind: "app", callee: innerApp.callee, args: [refIR(auxName)] } as TypeIR;
        return appIR(refIR("Null.t"), [replacedInner]);
      }
    }
  }
  // Hoist inline records nested under array<...> or dict<...> wrappers (and their Null.t variants)
  if (typ.kind === "app" && typ.callee.kind === "ref" && (isRefNamed(typ.callee, "array") || isRefNamed(typ.callee, "dict"))) {
    const inner = typ.args[0];
    if (!inner) return typ;
    if ((inner.kind === "record" || (inner.kind === "withDoc" && (inner as any).inner?.kind === "record")) && (typeof collectAuxIR === "function" || typeof collectAux === "function")) {
      const baseParent = parentName ?? "t";
      const propBase = toValidTypeName(`${baseParent}_${propName}`);
      if (typeof collectAuxIR === "function") {
        const arg0 = inner as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        const recIRNode = recordIR(newFields);
        const bodyIR = doc ? withDoc(doc, recIRNode) : recIRNode;
        const printed = printTypeIR(bodyIR);
        const auxName = nameWithHash(propBase, printed);
        collectAuxIR(auxName, bodyIR);
        return appIR(typ.callee, [refIR(auxName)]);
      } else {
        const arg0 = inner as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        let printed = (doc ? `${doc}\n` : "") + printTypeIR(recordIR(newFields));
        if (qualify) printed = qualifyComponentRefsPrinted(printed);
        const auxName = nameWithHash(propBase, printed);
        collectAux(auxName, printed);
        return appIR(typ.callee, [refIR(auxName)]);
      }
    }
    if (isNullApp(inner) && inner.args[0] && (inner.args[0]!.kind === "record" || (inner.args[0] as any).kind === "withDoc" && ((inner.args[0] as any).inner?.kind === "record")) && (typeof collectAux === "function" || typeof collectAuxIR === "function")) {
      const baseParent = parentName ?? "t";
      const propBase = toValidTypeName(`${baseParent}_${propName}`);
      if (typeof collectAuxIR === "function") {
        const arg0 = inner.args[0]! as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        const recNode = recordIR(newFields);
        const bodyIR = doc ? withDoc(doc, recNode) : recNode;
        const printed = printTypeIR(bodyIR);
        const auxName = nameWithHash(propBase, printed);
        collectAuxIR(auxName, bodyIR);
        const newInner = appIR(refIR("Null.t"), [refIR(auxName)]);
        return appIR(typ.callee, [newInner]);
      } else {
        const arg0 = inner.args[0]! as TypeIR;
        const doc = arg0.kind === "withDoc" ? arg0.doc : undefined;
        const rec0 = arg0.kind === "withDoc" ? arg0.inner : arg0;
        const prepared = qualify ? qualifyComponentRefsIR(rec0) : rec0;
        const newFields = prepared.fields.map((f) => {
          const nt = hoistFieldTypeIfNeeded(f.typ, collectAux, propBase, f.name, qualify, collectAuxIR);
          return nt === f.typ ? f : { ...f, typ: nt };
        });
        let printed = (doc ? `${doc}\n` : "") + printTypeIR(recordIR(newFields));
        const auxName = nameWithHash(propBase, printed);
        collectAux(auxName, printed);
        const newInner = appIR(refIR("Null.t"), [refIR(auxName)]);
        return appIR(typ.callee, [newInner]);
      }
    }
  }
  return typ;
}

// Unified IR hoisting pass: recursively traverse a TypeIR, and whenever a record appears
// in a position where inline records are not formatter-safe (inside wrappers or PV payloads),
// create an aux type and replace with a ref. Naming is based on the provided base name and
// a path segment for context. The pass also descends into allowed positions (e.g. record fields)
// to hoist nested wrappers like array<{...}>.
function hoistInlineRecordsIR(
  typ: TypeIR,
  collectAux: ((name: string, body: string) => void) | undefined,
  baseName: string,
  allowRecordHere: boolean,
  seg?: string,
  qualify: boolean = false,
  collectAuxIR?: (name: string, body: TypeIR) => void,
): TypeIR {
  const mkBase = (extra?: string) => toValidTypeName(extra ? `${baseName}_${extra}` : baseName);
  const mkAux = (body: string, hint?: string) => nameWithHash(mkBase(hint), body);
  const createAuxRef = (rec: TypeIR, hint?: string): TypeIR => {
    const baseNm = mkBase(hint);
    const prepared = qualify ? qualifyComponentRefsIR(rec) : rec;
    // Hoist direct record-typed fields inside this aux by walking fields
    const bodyIR = prepared.kind === "record"
      ? (() => {
          const newFields = prepared.fields.map((f) => {
            const newTyp = hoistFieldTypeIfNeeded(f.typ, collectAux, baseNm, f.name, qualify, collectAuxIR);
            return newTyp === f.typ ? f : { ...f, typ: newTyp };
          });
          return recordIR(newFields);
        })()
      : prepared;
    const printed = printTypeIR(bodyIR);
    const auxName = mkAux(printed, hint);
    if (typeof collectAuxIR === "function") {
      collectAuxIR(auxName, bodyIR);
    } else if (typeof collectAux === "function") {
      collectAux(auxName, printed);
    }
    return refIR(auxName);
  };
  switch (typ.kind) {
    case "withDoc":
      return { kind: "withDoc", doc: typ.doc, inner: hoistInlineRecordsIR(typ.inner, collectAux, baseName, allowRecordHere, seg, qualify, collectAuxIR) };
    case "record": {
      if (!allowRecordHere) {
        return createAuxRef(typ, seg);
      }
      const fields = typ.fields.map((f) => {
        const hint = toValidTypeName(f.name);
        // First, hoist direct record types appearing as field types to aux
        let first = hoistFieldTypeIfNeeded(f.typ, collectAux, baseName, f.name, qualify, collectAuxIR);
        // Then, descend to hoist any nested records under wrappers
        const newTyp = hoistInlineRecordsIR(first, collectAux, mkBase(hint), true, hint, qualify, collectAuxIR);
        return { ...f, typ: newTyp };
      });
      return { kind: "record", fields };
    }
    case "app": {
      const calleeIsRef = typ.callee.kind === "ref" ? typ.callee.path.join(".") : undefined;
      const wrapperKinds = new Set(["Null.t", "Nullable.t", "array", "dict"]);
      const isWrapper = calleeIsRef && wrapperKinds.has(calleeIsRef);
      const arg0 = typ.args[0];
      if (isWrapper && arg0) {
        let hint: string | undefined;
        if (calleeIsRef === "array") hint = "item";
        else if (calleeIsRef === "dict") hint = "value";
        // For Null.t/Nullable.t, keep current base and just traverse
        const newArg0 = hoistInlineRecordsIR(arg0, collectAux, hint ? mkBase(hint) : baseName, false, hint, qualify, collectAuxIR);
        const newArgs = [newArg0, ...typ.args.slice(1)];
        return { kind: "app", callee: typ.callee, args: newArgs };
      }
      // Generic descend into args just in case
      return { kind: "app", callee: typ.callee, args: typ.args.map((a, i) => hoistInlineRecordsIR(a, collectAux, mkBase(`arg_${i + 1}`), allowRecordHere, `arg_${i + 1}`, qualify, collectAuxIR)) };
    }
    case "poly": {
      const cases = typ.cases.map((c, i) => {
        if (!c.payload) return c;
        const raw = c.label.replace(/^#/, "").replace(/^\"|\"$/g, "");
        const labelHint = toValidTypeName(raw || `Member${i + 1}`);
        const payload = hoistInlineRecordsIR(c.payload, collectAux, mkBase(labelHint), false, labelHint, qualify, collectAuxIR);
        return { ...c, payload };
      });
      return { kind: "poly", cases };
    }
    case "adt": {
      const cases = typ.cases.map((c, i) => {
        if (!c.payload) return c;
        const raw = c.label.replace(/^#/, "").replace(/^\"|\"$/g, "");
        const labelHint = toValidTypeName(raw || `Case${i + 1}`);
        const payload = hoistInlineRecordsIR(c.payload, collectAux, mkBase(labelHint), false, labelHint, qualify, collectAuxIR);
        return { ...c, payload };
      });
      return { kind: "adt", cases };
    }
    case "tuple": {
      const items = typ.items.map((it, i) => hoistInlineRecordsIR(it, collectAux, mkBase(`item_${i + 1}`), false, `item_${i + 1}`, qualify, collectAuxIR));
      return { kind: "tuple", items };
    }
    default:
      return typ;
  }
}

function isRefNamed(t: TypeIR, name: string): boolean {
  return t.kind === "ref" && t.path.join(".") === name;
}

function isArrayIR(t: TypeIR): t is Extract<TypeIR, { kind: "app" }> & { callee: Extract<TypeIR, { kind: "ref" }> } {
  return t.kind === "app" && t.callee.kind === "ref" && t.callee.path.join(".") === "array" && t.args.length === 1;
}

function chooseNarrowerIR(a: TypeIR, b: TypeIR): "a" | "b" | undefined {
  if (alphaEq(a, b)) return "a";
  const aIsNull = isNullApp(a);
  const bIsNull = isNullApp(b);
  if (aIsNull && !bIsNull) return "a";
  if (bIsNull && !aIsNull) return "b";
  const aCore = aIsNull ? (a as Extract<TypeIR, { kind: "app" }>).args[0]! : a;
  const bCore = bIsNull ? (b as Extract<TypeIR, { kind: "app" }>).args[0]! : b;
  const aArr = isArrayIR(aCore) ? aCore : undefined;
  const bArr = isArrayIR(bCore) ? bCore : undefined;
  if (aArr && bArr) {
    const res = chooseNarrowerIR(aArr.args[0]!, bArr.args[0]!);
    return res ?? "a";
  }
  // Prefer PV union over primitive string/float
  const aIsPrim = aCore.kind === "ref" && (isRefNamed(aCore, "string") || isRefNamed(aCore, "float"));
  const bIsPrim = bCore.kind === "ref" && (isRefNamed(bCore, "string") || isRefNamed(bCore, "float"));
  if (aIsPrim && bCore.kind === "poly") return "b";
  if (bIsPrim && aCore.kind === "poly") return "a";
  return undefined;
}

function mapSchemaToRes(
  schema: SchemaLike,
  ctx: RSContext,
  {
    parentName,
    collectAux,
    optionalAsOption = false,
  }: {
    parentName?: string;
    collectAux?: (name: string, body: string) => void;
    optionalAsOption?: boolean;
  } = {}
): string {
  // IR wrapper: use structured IR + printer to avoid string-based nested type checks
  let ir = mapSchemaToIR(schema, ctx, { parentName, collectAux, optionalAsOption });
  ir = hoistInlineRecordsIR(
    ir,
    collectAux
      ? (n, b) => {
          const { doc, code } = splitDocBlock(b);
          collectAux(n, `${doc ? doc + "\n" : ""}${code}`);
        }
      : undefined,
    toValidTypeName(parentName ?? "t"),
    true,
  );
  return printTypeIR(ir);
}

// Experimental: structured IR for a subset of schema shapes (objects first).
// Falls back to raw string mapping for unsupported cases to preserve semantics.
function mapSchemaToIR(
  schema: SchemaLike,
  ctx: RSContext,
  {
    parentName,
    collectAux,
    optionalAsOption = false,
    qualifyOpsRefs = false,
    collectAuxIR,
    collectAuxDecl,
  }: {
    parentName?: string;
    collectAux?: (name: string, body: string) => void;
    optionalAsOption?: boolean;
    qualifyOpsRefs?: boolean;
    collectAuxIR?: (name: string, body: TypeIR) => void;
    collectAuxDecl?: (node: RSNode) => void;
  } = {}
): TypeIR {
  // Direct $ref handling
  if (isRef(schema)) {
    const ref = schema.$ref;
    if (typeof ref === "string" && ref.includes("/$defs/")) {
      const idx = ref.indexOf("/$defs/");
      if (idx >= 0) {
        const before = ref.slice(0, idx);
        const after = ref.slice(idx + "/$defs/".length);
        const schemaSeg = before.split("/").filter(Boolean).pop();
        const defSeg = after.split("/")[0];
        if (schemaSeg && defSeg) {
          const schemaNm = toValidTypeName(schemaSeg);
          const defNm = toValidTypeName(defSeg);
          return refIR(`${schemaNm}__def_${defNm}`);
        }
      }
      const m2 = ref.match(/#\/$defs\/([^/]+)$/);
      if (m2 && parentName) {
        const defNm = toValidTypeName(m2[1]!);
        return refIR(`${toValidTypeName(parentName)}__def_${defNm}`);
      }
    }
    const nm = refName(ref) ?? "unknown";
    // In operation/callback contexts, qualify component schema refs immediately in IR
    if (qualifyOpsRefs && COMPONENT_SCHEMA_NAMES.has(toValidTypeName(nm))) {
      return { kind: "ref", path: ["Components", "Schemas", toValidTypeName(nm)] };
    }
    return refIR(nm);
  }
  // Pre-hoist $defs if present (mirrors string path behavior)
  if (!isRef(schema)) {
    const s: SchemaObject = schema;
    // Basic primitives and nullable type arrays → IR
    if (Array.isArray((s as any).type)) {
      const arr = (s as any).type as unknown[];
      const hasNull = arr.includes("null");
      const others = arr.filter((t) => t !== "null");
      // string|number/integer (with optional null) → stringOrNumber
      const norm = new Set(others.map((t) => (t === "integer" ? "number" : String(t))));
      if (norm.size === 2 && norm.has("string") && norm.has("number")) {
        const base = refIR("stringOrNumber");
        return hasNull ? appIR(refIR("Null.t"), [base]) : base;
      }
      if (hasNull && others.length === 1) {
        const tmp: SchemaObject = { ...s, type: others[0] as any };
        const inner = mapSchemaToIR(tmp, ctx, { parentName, collectAux, collectAuxIR, optionalAsOption, qualifyOpsRefs, collectAuxDecl });
        return appIR(refIR("Null.t"), [inner]);
      }
    }
    if (typeof (s as any).type === "string" && !(Array.isArray((s as any).enum) && (s as any).enum.length > 0)) {
      const t = (s as any).type as string;
      if (t === "string" || t === "number" || t === "integer" || t === "boolean") {
        const base = t === "string" ? refIR("string") : t === "boolean" ? refIR("bool") : refIR("float");
        return s.nullable ? appIR(refIR("Null.t"), [base]) : base;
      }
    }
    // composition: oneOf / anyOf
    const unionMembers = s.oneOf ?? s.anyOf;
    if (Array.isArray(unionMembers) && unionMembers.length > 0) {
      const isNullTypeSchema = (m: SchemaLike | SchemaObject): boolean => {
        let mm: SchemaObject | undefined;
        if (isRef(m)) mm = ctx.resolve<SchemaObject>(m.$ref);
        else mm = m;
        if (!mm) return false;
        if (mm.type === "null") return true;
        if (Array.isArray(mm.type)) {
          let hasNull = false;
          let count = 0;
          for (const t of mm.type) {
            count++;
            if (t === "null") hasNull = true;
          }
          return hasNull && count === 1;
        }
        if (Array.isArray(mm.enum)) {
          return mm.enum.length === 1 && mm.enum[0] == null;
        }
        // Treat "nullable: true" with no meaningful shape as equivalent to null
        if (mm.nullable === true) {
          const keys = Object.keys(mm as Record<string, unknown>).filter((k) => !["title", "description", "deprecated", "readOnly", "writeOnly", "examples", "example", "nullable"].includes(k));
          if (keys.length === 0) return true;
          if (mm.type === "object") {
            const hasProps = "properties" in mm && (mm as any).properties && Object.keys((mm as any).properties ?? {}).length > 0;
            const hasAP = "additionalProperties" in mm;
            const hasCompo = Array.isArray((mm as any).oneOf) || Array.isArray((mm as any).anyOf) || Array.isArray((mm as any).allOf);
            if (!hasProps && !hasAP && !hasCompo) return true;
          }
        }
        return false;
      };
      const nonNullMembers = unionMembers.filter((m) => !isNullTypeSchema(m));
      const nullMembers = unionMembers.length - nonNullMembers.length;
      if (nullMembers >= 1 && nonNullMembers.length === 1) {
        const inner = mapSchemaToIR(nonNullMembers[0]!, ctx, { parentName, collectAux, optionalAsOption });
        return appIR(refIR("Null.t"), [inner]);
      }
      // Flatten union of literal enums/consts: if all non-null members are string/number literal lists,
      // emit a single PV (no Wrapped.t) with the union of values, optionally wrapped in Null.t.
      const literalSets: Array<{ kind: "string" | "number"; values: string[] }> = [];
      let literalOk = true;
      let litKind: "string" | "number" | undefined;
      for (const m of nonNullMembers) {
        const mm: SchemaObject | undefined = isRef(m) ? ctx.resolve<SchemaObject>(m.$ref) : (m as any);
        if (!mm || typeof mm !== "object") {
          literalOk = false;
          break;
        }
        let vals: any[] | undefined;
        if (Array.isArray((mm as any).enum) && (mm as any).enum.length > 0) vals = (mm as any).enum as any[];
        else if ("const" in (mm as any)) vals = [(mm as any).const];
        if (!vals) {
          literalOk = false;
          break;
        }
        const allStrings = vals.every((v) => typeof v === "string");
        const allNumbers = vals.every((v) => typeof v === "number");
        if (!allStrings && !allNumbers) {
          literalOk = false;
          break;
        }
        const kind: "string" | "number" = allStrings ? "string" : "number";
        if (!litKind) litKind = kind;
        if (litKind !== kind) {
          literalOk = false; // mixed primitive kinds
          break;
        }
        literalSets.push({ kind, values: vals.map((x) => String(x)) });
      }
      if (literalOk && literalSets.length > 0) {
        const unionVals = new Set<string>();
        for (const sset of literalSets) for (const v of sset.values) unionVals.add(v);
        const labels = [...unionVals].sort((a, b) => a.localeCompare(b)).map((v) => ({ label: pvLabelForValue(v) }));
        let out: TypeIR = polyIR(labels);
        if (nullMembers >= 1) out = appIR(refIR("Null.t"), [out]);
        return out;
      }
      const allRefs = unionMembers.every((m) => isRef(m));
      const disc: DiscriminatorObject | undefined = s.discriminator;
      // Special-case: union of primitive string and number/integer → stringOrNumber
      {
        let ok = true;
        let sawStr = false;
        let sawNum = false;
        for (const m of nonNullMembers) {
          const mm: SchemaObject | undefined = isRef(m) ? ctx.resolve<SchemaObject>(m.$ref) : (m as any);
          if (!mm || typeof mm !== "object") { ok = false; break; }
          // Require a direct primitive type with no enum/const to avoid clobbering literal unions
          if ((mm as any).enum || (mm as any).const != null) { ok = false; break; }
          const t = (mm as any).type;
          if (t === "string") sawStr = true;
          else if (t === "number" || t === "integer") sawNum = true;
          else { ok = false; break; }
        }
        if (ok && sawStr && sawNum) {
          let out: TypeIR = refIR("stringOrNumber");
          if (nullMembers >= 1) out = appIR(refIR("Null.t"), [out]);
          return out;
        }
      }
      let mapRefNameToLabel: Map<string, string> | undefined;
      if (disc && typeof disc === "object" && disc.mapping && typeof disc.mapping === "object") {
        mapRefNameToLabel = new Map<string, string>();
        for (const [val, refStr] of Object.entries(disc.mapping)) {
          const rn = typeof refStr === "string" ? refName(refStr) : undefined;
          if (rn) mapRefNameToLabel.set(rn, toValidModuleName(val));
        }
      }
      if (allRefs) {
        // Ref-only union inside a property: emit ADT + `<name>_wrapped` alias and codec module
        // instead of falling back to JSON.t when we can append declarations.
        if (typeof collectAuxDecl === "function") {
          // Try to detect a simple untagged union to build a decoder; otherwise use encode-only JSON decoders.
          const det = detectSimpleUntaggedUnion(unionMembers as SchemaLike[], ctx, disc);
          const adtName = toValidTypeName(`${parentName ?? "t"}_union`);
          const aliasName = toValidTypeName(`${adtName}_wrapped`);
          // Build cases from refs
          const refCases: Array<{ label: string; payload: TypeIR }> = [];
          if (det && (det as any).ok) {
            const labels = (det as any).labels as string[];
            for (let i = 0; i < unionMembers.length; i++) {
              const m = unionMembers[i]!;
              if (!isRef(m)) continue;
              const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
              refCases.push({ label: labels[i]!, payload: refIR(rn) });
            }
            if ((det as any).allowUnknown) refCases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
            // Emit ADT + alias and decoder/encoder module
            collectAuxDecl({ kind: "attr", code: '@tag("kind")' });
            collectAuxDecl({ kind: "type", keyword: "type rec", name: adtName, body: adtIR(refCases) });
            collectAuxDecl({ kind: "raw", code: `and ${aliasName}` });
            // Decoder module with signals
            type Step = { kind: "literal"; prop: string } | { kind: "keys" };
            const steps: Step[] = [];
            const seenLitProps = new Set<string>();
            const litMap = new Map<string, Array<{ value: string; label: string }>>();
            let sawKeys = false;
            const keyPairs: Array<{ prop: string; label: string }> = [];
            if ((det as any).ok) {
              for (let i = 0; i < (det as any).signals.length; i++) {
                const sig = (det as any).signals[i]! as any;
                const label = (det as any).labels[i]!;
                if (sig.kind === "literal") {
                  const arr = litMap.get(sig.prop) ?? [];
                  arr.push({ value: String(sig.value), label });
                  litMap.set(sig.prop, arr);
                  if (!seenLitProps.has(sig.prop)) { steps.push({ kind: "literal", prop: sig.prop }); seenLitProps.add(sig.prop); }
                } else {
                  keyPairs.push({ prop: sig.prop, label });
                  if (!sawKeys) { steps.push({ kind: "keys" }); sawKeys = true; }
                }
              }
            }
            const buildTailOpt = (): string => {
              let tail = (det as any).allowUnknown ? 'Some(UnionDecode.make("Unknown", json))' : 'None';
              for (let i = steps.length - 1; i >= 0; i--) {
                const st = steps[i]!;
                if (st.kind === "literal") {
                  const arr = litMap.get(st.prop) ?? [];
                  const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                  const mapLit = `dict{${parts}}`;
                  const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                  tail = `${head}${tail}}`;
                } else {
                  const parts = keyPairs.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                  const mapKey = `dict{${parts}}`;
                  const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                  tail = `${head}${tail}}`;
                }
              }
              return tail;
            };
            const decDoc = wrapBlockDoc(
              [
                "Decoder for simple untagged union.",
                "Matching signals:",
                ...((det as any).signals as any[]).map((s: any, i: number) =>
                  s.kind === "literal"
                    ? `- ${(det as any).labels[i]!}: ${s.prop} == ${s.value}`
                    : `- ${(det as any).labels[i]!}: has key ${s.prop}`
                ),
                (det as any).allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
              ].join("\n")
            );
            if (decDoc) collectAuxDecl({ kind: "raw", code: decDoc });
            const rsPriv = [
              "%%private(",
              `let decode_: ${aliasName} => option<${adtName}> = json => {`,
              `  ${buildTailOpt()}`,
              `}`,
              ")",
            ].join("\n");
            const rsThrow = [
              `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
              `  switch decode_(json) {`,
              `  | Some(v) => v`,
              `  | None => JsError.throwWithMessage(\"No matching union member\")`,
              `  }`,
              `}`,
            ].join("\n");
            const rsRes = [
              `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
              `  switch decode_(json) {`,
              `  | Some(v) => Ok(v)`,
              `  | None => Error(#DecodeError(\"No matching union member\"))`,
              `  }`,
              `}`,
            ].join("\n");
            const rsEncode = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
            collectAuxDecl({ kind: "module", name: toValidModuleName(adtName), items: [
              { kind: "raw", code: rsPriv },
              { kind: "raw", code: rsThrow },
              { kind: "raw", code: rsRes },
              { kind: "raw", code: rsEncode },
            ]});
            let out: TypeIR = refIR(aliasName);
            if (s.nullable) out = appIR(refIR("Null.t"), [out]);
            return out;
          } else {
            // Ambiguous: still emit ADT + alias with JSON.t decoders
            const seen = new Set<string>();
            const cases: Array<{ label: string; payload: TypeIR }> = [];
            for (const m of unionMembers) {
              if (!isRef(m)) continue;
              const typeNm = refName(m.$ref) ?? "unknown";
              let inferred: string | undefined;
              if (disc && disc.propertyName) {
                const resolved = ctx.resolve<SchemaObject>(m.$ref);
                const propName = disc.propertyName;
                if (resolved && typeof resolved === "object") {
                  let props: Record<string, SchemaLike> = {};
                  if ("properties" in resolved && resolved.properties) props = resolved.properties;
                  const ds = props ? props[propName] : undefined;
                  let dso: SchemaObject | undefined;
                  if (ds) dso = isRef(ds) ? ctx.resolve<SchemaObject>(ds.$ref) : ds;
                  const val = dso && typeof dso === "object" && ("const" in dso ? dso.const : Array.isArray(dso.enum) && dso.enum.length === 1 ? dso.enum[0] : undefined);
                  if (val !== undefined) inferred = toValidModuleName(String(val));
                }
              }
              let label = mapRefNameToLabel?.get(typeNm) ?? inferred ?? toValidModuleName(typeNm);
              let uniq = label;
              let i = 2;
              while (seen.has(uniq)) uniq = `${label}_${i++}`;
              seen.add(uniq);
              cases.push({ label: uniq, payload: refIR(typeNm) });
            }
            collectAuxDecl({ kind: "attr", code: '@tag("kind")' });
            collectAuxDecl({ kind: "type", keyword: "type rec", name: adtName, body: adtIR(cases) });
            collectAuxDecl({ kind: "raw", code: `and ${aliasName}` });
            const rsCodec = [
              `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
              `let decodeOrThrow: ${aliasName} => JSON.t = v => Obj.magic(v)`,
              `let decode: ${aliasName} => result<JSON.t, [> #DecodeError(string)]> = v => Ok(Obj.magic(v))`,
            ].join("\n");
            collectAuxDecl({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsCodec } ] });
            let out: TypeIR = refIR(aliasName);
            if (s.nullable) out = appIR(refIR("Null.t"), [out]);
            return out;
          }
        }
        // No declaration collector available → conservative fallback
        let out: TypeIR = refIR("JSON.t");
        if (s.nullable) out = appIR(refIR("Null.t"), [out]);
        return out;
      }
      // Mixed or inline members
      const seen = new Set<string>();
      const cases: Array<{ label: string; payload?: TypeIR }> = [];
      let foundNullishUnknown = false; // track Null.t<unknown> members to enable Null-wrapping when single other case exists
      unionMembers.forEach((m, idx) => {
        if (isRef(m)) {
          const $ref = m.$ref;
          const typeNm = refName($ref) ?? "unknown";
          let inferred: string | undefined;
          if (disc && disc.propertyName) {
            const resolved = ctx.resolve<SchemaObject>($ref);
            const propName = disc.propertyName;
            if (resolved && typeof resolved === "object") {
              let props: Record<string, SchemaLike> = {};
      if ("properties" in resolved && resolved.properties) props = resolved.properties;
              const ds = props ? props[propName] : undefined;
              let dso: SchemaObject | undefined;
              if (ds) dso = isRef(ds) ? ctx.resolve<SchemaObject>(ds.$ref) : ds;
              const val = dso && typeof dso === "object" && ("const" in dso ? dso.const : Array.isArray(dso.enum) && dso.enum.length === 1 ? dso.enum[0] : undefined);
              if (val !== undefined) inferred = toValidModuleName(String(val));
            }
          }
          let label = inferred ?? toValidModuleName(typeNm);
          let uniq = label;
          let k = 2;
          while (seen.has(uniq)) uniq = `${label}_${k++}`;
          seen.add(uniq);
          cases.push({ label: `#${uniq}`, payload: refIR(typeNm) });
        } else {
          // Map member; hoist inline records to aux types
          const ir = mapSchemaToIR(m, ctx, { parentName, collectAux, optionalAsOption, qualifyOpsRefs });
          const printedIR = printTypeIR(ir).trim();
          // Drop unknown-only members; treat Null.t<unknown> as a nullish indicator
          if (printedIR === "unknown") {
            return; // skip
          }
          if (/^Null\.t<\s*unknown\s*>$/.test(printedIR)) {
            foundNullishUnknown = true;
            return; // skip adding explicit case for Null.t<unknown>
          }
          let payload: TypeIR = ir;
          if (typeof collectAux === "function") {
            if (ir.kind === "record") {
              const printed = printTypeIR(qualifyOpsRefs ? qualifyComponentRefsIR(ir) : ir);
              const base = toValidTypeName(`${parentName ?? "t"}_member_${idx + 1}`);
              const auxName = nameWithHash(base, printed);
              collectAux(auxName, printed);
              payload = refIR(auxName);
            } else if (isNullApp(ir) && ir.args[0] && ir.args[0]!.kind === "record") {
              const rec = ir.args[0]!;
              const printed = printTypeIR(qualifyOpsRefs ? qualifyComponentRefsIR(rec) : rec);
              const base = toValidTypeName(`${parentName ?? "t"}_member_${idx + 1}`);
              const auxName = nameWithHash(base, printed);
              collectAux(auxName, printed);
              payload = appIR(refIR("Null.t"), [refIR(auxName)]);
            }
          }
          let inferred: string | undefined;
          if (disc && disc.propertyName && m && typeof m === "object") {
            const propName = disc.propertyName;
            const mm = m;
            let props: Record<string, SchemaLike> = {};
            if ("properties" in mm && mm.properties) props = mm.properties;
            const ds = props ? props[propName] : undefined;
            let dso: SchemaObject | undefined;
            if (ds) dso = isRef(ds) ? ctx.resolve<SchemaObject>(ds.$ref) : ds;
            const val = dso && typeof dso === "object" && ("const" in dso ? dso.const : Array.isArray(dso.enum) && dso.enum.length === 1 ? dso.enum[0] : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
          let label = inferred ?? toValidModuleName(`Member${idx + 1}`);
          let uniq = label;
          let k2 = 2;
          while (seen.has(uniq)) uniq = `${label}_${k2++}`;
          seen.add(uniq);
          cases.push({ label: `#${uniq}`, payload });
        }
      });
      // If the only non-unknown case remains and we saw a Null.t<unknown> member, prefer Null-wrapping that case directly
      if (foundNullishUnknown && cases.length === 1 && cases[0]!.payload) {
        return appIR(refIR("Null.t"), [cases[0]!.payload!]);
      }
      // Remaining general union: emit ADT + alias + codec when a decl collector is available;
      // otherwise, conservative fallback to JSON.t.
      if (typeof collectAuxDecl === "function") {
        const adtBase = toValidTypeName(`${parentName ?? "t"}_union`);
        const adtName = adtBase;
        const aliasName = toValidTypeName(`${adtName}_wrapped`);
        // Build ADT cases from `cases` collected above; strip leading '#' from labels
        const adtCases = cases.map((c) => ({ label: c.label.replace(/^#/, ""), payload: c.payload! }));
        const ambDoc = wrapBlockDoc("Ambiguous untagged union: encode-only; decoders return JSON.t (no unique discriminator).");
        if (ambDoc) collectAuxDecl({ kind: "raw", code: ambDoc });
        collectAuxDecl({ kind: "attr", code: '@tag("kind")' });
        // Rec chain: ADT first; any hoisted record payloads are already in collectAux/collectAuxIR paths
        collectAuxDecl({ kind: "type", keyword: "type rec", name: adtName, body: adtIR(adtCases) });
        collectAuxDecl({ kind: "raw", code: `and ${aliasName}` });
        // Codec with JSON.t decoders (casts)
        const rsCodec = [
          `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
          `let decodeOrThrow: ${aliasName} => JSON.t = v => Obj.magic(v)`,
          `let decode: ${aliasName} => result<JSON.t, [> #DecodeError(string)]> = v => Ok(Obj.magic(v))`,
        ].join("\n");
        collectAuxDecl({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsCodec } ] });
        let out: TypeIR = refIR(aliasName);
        if (s.nullable) out = appIR(refIR("Null.t"), [out]);
        return out;
      } else {
        let out: TypeIR = refIR("JSON.t");
        if (s.nullable) out = appIR(refIR("Null.t"), [out]);
        return out;
      }
    }
    // Enums: strings/numbers → PV union via poly IR
    if (Array.isArray(s.enum) && s.enum.length > 0) {
      const vals = s.enum;
      const allStrings = vals.every((v) => typeof v === "string");
      const allNumbers = vals.every((v) => typeof v === "number");
      if (allStrings || allNumbers) {
        const sorted = [...vals].sort((a, b) => String(a).localeCompare(String(b)));
        const label = (v: string): string => {
          const isIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
          const isReserved = RES_KEYWORDS.has(v);
          return isIdent && !isReserved ? `#${v}` : `#${JSON.stringify(v)}`;
        };
        const cases = sorted.map((v) => ({ label: label(String(v)) }));
        const pv = polyIR(cases);
        if (s.nullable) return appIR(refIR("Null.t"), [pv]);
        return pv;
      }
    }
    if (hasDefs(s) && (typeof collectAux === "function" || typeof collectAuxIR === "function")) {
      for (const [k, v] of Object.entries(s.$defs)) {
        const auxName = `${parentName ?? "t"}__def_${toValidTypeName(k)}`;
        const ir = mapSchemaToIR(v, ctx, {
          parentName: auxName,
          collectAux,
          collectAuxIR,
          optionalAsOption,
        });
        const qualified = qualifyOpsRefs ? qualifyComponentRefsIR(ir) : ir;
        if (typeof collectAuxIR === "function") collectAuxIR(auxName, qualified);
        else if (typeof collectAux === "function") collectAux(auxName, printTypeIR(qualified));
      }
    }
    // Arrays
    if (s && typeof s === "object" && s.type === "array" && s.items && !Array.isArray(s.items)) {
      let inner = mapSchemaToIR(s.items, ctx, { parentName, collectAux, collectAuxIR, optionalAsOption, qualifyOpsRefs, collectAuxDecl });
      inner = hoistInlineRecordsIR(
        inner,
        collectAux,
        toValidTypeName(`${parentName ?? "t"}_item`),
        false,
        "item",
        /*qualify*/ !!qualifyOpsRefs,
        collectAuxIR,
      );
      let arrIR = appIR(refIR("array"), [inner]);
      if (s.nullable) arrIR = appIR(refIR("Null.t"), [arrIR]);
      return arrIR;
    }
    // Object-as-dict
    if (
      (s.type === "object" || "properties" in s || "additionalProperties" in s) &&
      !("properties" in s && s.properties && Object.keys(s.properties ?? {}).length > 0)
    ) {
      // patternProperties → dict<JSON.t>
      const patternProps = "patternProperties" in s ? s.patternProperties : undefined;
      if (patternProps && typeof patternProps === "object" && Object.keys(patternProps).length > 0) {
        const base = refIR("dict");
        const out = appIR(base, [refIR("JSON.t")]);
        return s.nullable ? appIR(refIR("Null.t"), [out]) : out;
      }
      // additionalProperties handling
      if ("additionalProperties" in s && s.additionalProperties !== undefined) {
        const ap = s.additionalProperties;
        if (ap === true) {
          const out = appIR(refIR("dict"), [refIR("JSON.t")]);
          return s.nullable ? appIR(refIR("Null.t"), [out]) : out;
        }
        if (ap === false) {
          return s.nullable ? appIR(refIR("Null.t"), [refIR("emptyObject")]) : refIR("emptyObject");
        }
        const valueBase = toValidTypeName(`${parentName ?? "t"}_value`);
        const emitValueAux = (rec: TypeIR, doc?: string, wrapNull?: boolean): TypeIR => {
          const prepared = qualifyOpsRefs ? qualifyComponentRefsIR(rec) : rec;
          const recWithHoistedFields = prepared.kind === "record"
            ? recordIR(
                prepared.fields.map((f) => {
                  const newTyp = hoistFieldTypeIfNeeded(f.typ, collectAux, valueBase, f.name, !!qualifyOpsRefs, collectAuxIR);
                  return newTyp === f.typ ? f : { ...f, typ: newTyp };
                })
              )
            : prepared;
          const printed = (doc ? `${doc}\n` : "") + printTypeIR(recWithHoistedFields);
          const auxName = nameWithHash(valueBase, printed);
          if (typeof collectAuxIR === "function") collectAuxIR(auxName, doc ? withDoc(doc, recWithHoistedFields) : recWithHoistedFields);
          else if (typeof collectAux === "function") collectAux(auxName, printed);
          const ref = refIR(auxName);
          return wrapNull ? appIR(refIR("Null.t"), [ref]) : ref;
        };
        // Special-case: type: ["object", "null"] on additionalProperties → Null.t<AuxValue>
        if (ap && typeof ap === "object" && !Array.isArray((ap as any))) {
          const apObj = ap as SchemaObject;
          if (Array.isArray((apObj as any).type)) {
            const arr = (apObj as any).type as unknown[];
            const hasNull = arr.includes("null");
            const hasObject = arr.includes("object");
            if (hasObject) {
              // Build a shallow object schema view for the object member
              const recOnly: SchemaObject = { ...apObj, type: "object" } as any;
              let recIR = mapSchemaToIR(recOnly, ctx, { parentName, collectAux, collectAuxIR, optionalAsOption, qualifyOpsRefs });
              if (recIR.kind === "withDoc" && recIR.inner.kind === "record") recIR = recIR.inner;
              if (recIR.kind === "record") {
                const inner = emitValueAux(recIR, undefined, hasNull);
                const out = appIR(refIR("dict"), [inner]);
                return s.nullable ? appIR(refIR("Null.t"), [out]) : out;
              }
            }
          }
        }
        let valueIR = mapSchemaToIR(ap, ctx, { parentName, collectAux, collectAuxIR, optionalAsOption, qualifyOpsRefs });
        // First-class value hoisting: create a stable aux for record or Null.t<record>
        let inner: TypeIR;
        if (valueIR.kind === "record") {
          inner = emitValueAux(valueIR, undefined, false);
        } else if (valueIR.kind === "withDoc" && valueIR.inner.kind === "record") {
          inner = emitValueAux(valueIR.inner, valueIR.doc, false);
        } else if (isNullApp(valueIR)) {
          const a0 = valueIR.args[0];
          if (a0 && (a0.kind === "record" || (a0.kind === "withDoc" && (a0 as any).inner?.kind === "record"))) {
            const doc = a0.kind === "withDoc" ? (a0 as any).doc : undefined;
            const rec0 = a0.kind === "withDoc" ? (a0 as any).inner : a0;
            inner = emitValueAux(rec0, doc, true);
          } else {
            // Recurse to hoist deeper nested records under wrappers
            inner = hoistInlineRecordsIR(
              valueIR,
              collectAux,
              valueBase,
              false,
              "value",
              /*qualify*/ !!qualifyOpsRefs,
              collectAuxIR,
            );
          }
        } else {
          // Recurse to hoist deeper nested records under wrappers
          inner = hoistInlineRecordsIR(
            valueIR,
            collectAux,
            valueBase,
            false,
            "value",
            /*qualify*/ !!qualifyOpsRefs,
            collectAuxIR,
          );
        }
        const out = appIR(refIR("dict"), [inner]);
        return s.nullable ? appIR(refIR("Null.t"), [out]) : out;
      }
    }
    // allOf → merge object-like members via IR; handle arrays/scalars via IR as well
    if (Array.isArray(s.allOf) && s.allOf.length > 0) {
      const tryInlineObject = (v: SchemaLike): SchemaObject | undefined => {
        const node = isRef(v) ? ctx.resolve<SchemaObject>(v.$ref) : v;
        if (!node) return undefined;
        if (Array.isArray(node.allOf) && node.allOf.length > 0) {
          for (const m of node.allOf) {
            const obj = tryInlineObject(m);
            if (obj) return obj;
          }
        }
        if (node.type === "object" || "properties" in node || "additionalProperties" in node) return node;
        return undefined;
      };
      const isAnnotationOnly = (node?: SchemaObject): boolean => {
        if (!node || typeof node !== "object") return false;
        const keys = Object.keys(node as Record<string, unknown>);
        return keys.every((k) => ["title", "description", "deprecated", "readOnly", "writeOnly", "examples", "example"].includes(k));
      };
      const chooseNarrower = (aTy: string, bTy: string): "a" | "b" | undefined => {
        if (aTy === bTy) return "a";
        const isNullWrapped = (t: string): boolean => /^\s*Null\.t</.test(t);
        const unwrapNull = (t: string): string => (isNullWrapped(t) ? t.replace(/^\s*Null\.t</, "").replace(/>\s*$/, "") : t);
        const isArrayType = (t: string): { ok: true; inner: string } | { ok: false } => {
          const m = t.trim().match(/^array<(.+)>$/);
          return m ? { ok: true, inner: m[1]!.trim() } : { ok: false };
        };
        const isPVUnion = (t: string): boolean => /^\[\s*#/.test(t.trim());
        const aNull = isNullWrapped(aTy);
        const bNull = isNullWrapped(bTy);
        if (aNull && !bNull) return "a";
        if (bNull && !aNull) return "b";
        const aArr = isArrayType(unwrapNull(aTy));
        const bArr = isArrayType(unwrapNull(bTy));
        if (aArr.ok && bArr.ok) {
          const res = chooseNarrower(aArr.inner, bArr.inner);
          return res ?? "a";
        }
        if ((aTy === "string" && isPVUnion(bTy)) || (aTy === "float" && isPVUnion(bTy))) return "b";
        if ((bTy === "string" && isPVUnion(aTy)) || (bTy === "float" && isPVUnion(aTy))) return "a";
        const prim = new Set(["string", "float", "bool", "unknown", "JSON.t"]);
        const isAlias = (t: string): boolean => {
          if (prim.has(t)) return false;
          if (isPVUnion(t)) return false;
          if (isArrayType(t).ok) return false;
          return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.trim());
        };
        const aAlias = isAlias(aTy);
        const bAlias = isAlias(bTy);
        if (aAlias && !bAlias) return "a";
        if (bAlias && !aAlias) return "b";
        if (aAlias && bAlias) return "a";
        return undefined;
      };
      const resolved: Array<SchemaObject | undefined> = s.allOf.map((m) => (isRef(m) ? ctx.resolve<SchemaObject>(m.$ref) : m));
      const filtered = resolved.filter((r) => !isAnnotationOnly(r));
      const topNullable = !!s.nullable || filtered.some((r) => !!r?.nullable);
      const objectLikes = filtered.map((r) => (r ? tryInlineObject(r) : undefined)).filter((x): x is SchemaObject => Boolean(x));
      if (objectLikes.length > 0) {
        const required = new Set<string>();
        type MergedProp = { ir: TypeIR; docs: string[]; conflicted?: boolean };
        const merged = new Map<string, MergedProp>();
        const order: string[] = [];
        for (const obj of objectLikes) {
          const req = Array.isArray(obj.required) ? obj.required : [];
          for (const r of req) required.add(r);
          const props: Record<string, SchemaLike> = "properties" in obj && obj.properties ? (obj.properties as Record<string, SchemaLike>) : {};
          for (const [k, v] of Object.entries(props)) {
            let ir = mapSchemaToIR(v, ctx, {
              parentName,
              collectAux,
              optionalAsOption,
              qualifyOpsRefs,
              collectAuxIR,
              collectAuxDecl,
            });
            ir = hoistFieldTypeIfNeeded(ir, collectAux, parentName, k, qualifyOpsRefs, collectAuxIR);
            const entry = merged.get(k);
            const desc = (v as SchemaObject).description;
            if (!entry) {
              merged.set(k, { ir, docs: desc ? [desc] : [] });
              order.push(k);
            } else {
              if (!alphaEq(entry.ir, ir)) {
                const pref = chooseNarrowerIR(entry.ir, ir);
                if (pref === "b") {
                  entry.ir = ir;
                  entry.conflicted = false;
                } else if (pref === "a") {
                  // keep existing
                } else {
                  // mark conflict, keep existing to remain conservative
                  entry.conflicted = true;
                }
              }
              if (desc) entry.docs.push(desc);
            }
          }
        }
        let fields: FieldIR[] = [];
        const used = new Set<string>();
        for (const propName of order) {
          const ent = merged.get(propName)!;
          let pIR = ent.ir;
          const { rendered, attr } = toValidResFieldName(propName);
          let name = rendered;
          let i = 2;
          while (used.has(name)) name = `${rendered}__${i++}`;
          used.add(name);
          const isReq = required.has(propName);
          const field: FieldIR = {
            name,
            attr: attr ?? undefined,
            typ: qualifyOpsRefs ? qualifyComponentRefsIR(pIR) : pIR,
          };
          if (!isReq) {
            if (optionalAsOption) {
              const inner = unwrapNull(pIR);
              if (inner) field.typ = appIR(refIR("Nullable.t"), [inner]);
              else field.optional = "option";
            } else {
              field.optional = "questionMark";
            }
          }
          const propDoc = ent.docs.filter(Boolean).join("\n");
          const docParts: string[] = [];
          if (propDoc.length > 0) docParts.push(propDoc);
          if (ent.conflicted) docParts.push("TODO: allOf field type conflict; using first");
          const fbAllOf = docForJSONFallback(field.typ);
          if (fbAllOf) docParts.push(fbAllOf);
          const combined = docParts.length > 0 ? wrapBlockDoc(docParts.join("\n")) : undefined;
          if (combined) field.doc = combined;
          fields.push(field);
        }
        const rec = recordIR(fields);
        if (topNullable) {
          const prepared = qualifyOpsRefs ? qualifyComponentRefsIR(rec) : rec;
          const printed = printTypeIR(prepared);
          const auxName = nameWithHash(toValidTypeName(`${parentName ?? "t"}__shape`), printed);
          if (typeof collectAuxIR === "function") {
            collectAuxIR(auxName, prepared);
            return appIR(refIR("Null.t"), [refIR(auxName)]);
          } else if (typeof collectAux === "function") {
            collectAux(auxName, printed);
            return appIR(refIR("Null.t"), [refIR(auxName)]);
          }
          // No aux collector available; return inline Null.t<rec>
          return appIR(refIR("Null.t"), [rec]);
        }
        return rec;
      }
      // Arrays/scalars handling via IR
      const arrayMembers = filtered.filter((r) => r && r.type === "array" && r.items && !Array.isArray(r.items)) as Array<SchemaObject & ArraySubtype>;
      if (arrayMembers.length > 0) {
        const itemsIRs = arrayMembers.map((am) =>
          mapSchemaToIR(am.items!, ctx, {
            parentName,
            collectAux,
            optionalAsOption,
            qualifyOpsRefs,
            collectAuxIR,
            collectAuxDecl,
          })
        );
        let chosen = itemsIRs[0]!;
        let note: string | undefined;
        for (let i = 1; i < itemsIRs.length; i++) {
          if (!alphaEq(chosen, itemsIRs[i]!)) {
            note = "TODO: allOf array items differ; using first";
            break;
          }
        }
        // Hoist inline records for items
        chosen = hoistInlineRecordsIR(
          chosen,
          collectAux,
          toValidTypeName(`${parentName ?? "t"}_item`),
          false,
          "item",
          /*qualify*/ !!qualifyOpsRefs,
        );
        let arrIR: TypeIR = appIR(refIR("array"), [chosen]);
        if (topNullable) arrIR = appIR(refIR("Null.t"), [arrIR]);
        if (note) arrIR = withDoc(wrapBlockDoc(note), arrIR);
        return arrIR;
      }
      // Scalars and enums
      const enumSets: Array<{ kind: "string" | "number"; values: string[] }> = [];
      for (const r of filtered) {
        if (!r) continue;
        if (Array.isArray(r.enum) && r.enum.length > 0) {
          const allStrings = r.enum.every((v) => typeof v === "string");
          const allNumbers = r.enum.every((v) => typeof v === "number");
          if (allStrings) enumSets.push({ kind: "string", values: (r.enum as any[]).map((x) => String(x)) });
          else if (allNumbers) enumSets.push({ kind: "number", values: (r.enum as any[]).map((x) => String(x)) });
        }
      }
      if (enumSets.length > 0) {
        const sameKind = enumSets.every((e) => e.kind === enumSets[0]!.kind);
        if (sameKind) {
          let inter = new Set(enumSets[0]!.values);
          for (let i = 1; i < enumSets.length; i++) {
            const cur = new Set(enumSets[i]!.values);
            inter = new Set([...inter].filter((x) => cur.has(x)));
          }
          let pv: TypeIR;
          let note: string | undefined;
          if (inter.size > 0) {
            const labels = [...inter].sort((a, b) => a.localeCompare(b)).map((v) => ({ label: pvLabelForValue(v) }));
            pv = polyIR(labels);
          } else {
            const first = enumSets[0]!.values;
            const labels = [...first].sort((a, b) => a.localeCompare(b)).map((v) => ({ label: pvLabelForValue(v) }));
            pv = polyIR(labels);
            note = "TODO: allOf enum intersection empty; using first";
          }
          let out: TypeIR = pv;
          if (topNullable) out = appIR(refIR("Null.t"), [out]);
          if (note) out = withDoc(wrapBlockDoc(note), out);
          return out;
        }
      }
      // Base primitives
      const primOrder: Array<"string" | "number" | "integer" | "boolean"> = ["string", "number", "integer", "boolean"];
      let chosenPrim: TypeIR | undefined;
      let conflictNote: string | undefined;
      let firstPrimKind: string | undefined;
      for (const r of filtered) {
        if (!r) continue;
        const t = r.type;
        if (t && (t === "string" || t === "number" || t === "integer" || t === "boolean")) {
          if (!chosenPrim) {
            firstPrimKind = t;
            const mapped = t === "string" ? refIR("string") : t === "boolean" ? refIR("bool") : refIR("float");
            chosenPrim = mapped;
          } else if (firstPrimKind && t !== firstPrimKind) {
            conflictNote = "TODO: allOf mixed scalars; using first";
            break;
          }
        }
      }
      if (chosenPrim) {
        let out: TypeIR = chosenPrim;
        if (topNullable) out = appIR(refIR("Null.t"), [out]);
        if (conflictNote) out = withDoc(wrapBlockDoc(conflictNote), out);
        return out;
      }
      // Ref + wrapper (nullable) or annotation-only → pass-through ref
      const refMembers = s.allOf.filter(isRef) as ReferenceObject[];
      if (refMembers.length === 1 && filtered.length <= 1) {
        let out: TypeIR = refIR(refName(refMembers[0]!.$ref) ?? "unknown");
        if (topNullable) out = appIR(refIR("Null.t"), [out]);
        return out;
      }
      // Fallback: emit JSON.t (nullable if needed) with TODO doc
      {
        const note = wrapBlockDoc("TODO: cannot safely map allOf; using JSON.t");
        let out: TypeIR = refIR("JSON.t");
        if (topNullable) out = appIR(refIR("Null.t"), [out]);
        return note ? withDoc(note, out) : out;
      }
    }
    // Only object-with-properties is handled structurally for now.
    if (isObjectSchema(s)) {
      let props: Record<string, SchemaLike> = {};
      const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
      if ("properties" in s && s.properties) props = s.properties;
      const propEntries = getEntries<SchemaLike>(props);
      if (propEntries.length > 0) {
        const used: Set<string> = new Set();
        let fields: FieldIR[] = [];
        for (const [propName, propSchema] of propEntries) {
          // Build IR for the property type
          const propParent = toValidTypeName(`${parentName ?? "t"}_${toValidTypeName(propName)}`);
          let pIR = mapSchemaToIR(propSchema, ctx, {
            parentName: propParent,
            collectAux,
            optionalAsOption,
            qualifyOpsRefs,
            collectAuxIR,
            // Propagate decl collector so nested oneOf/anyOf can emit _wrapped ADTs/codecs
            collectAuxDecl,
          });
          // Hoist inline records under wrappers or as direct property types to reduce nesting
          pIR = hoistFieldTypeIfNeeded(pIR, collectAux, parentName, propName, qualifyOpsRefs, collectAuxIR);
          // Additionally, run the unified hoist pass on the property type to catch
          // nested records inside wrappers like Null.t<array<{...}>> and qualify refs in op contexts.
          pIR = hoistInlineRecordsIR(
            pIR,
            collectAux,
            toValidTypeName(`${parentName ?? "t"}_${toValidTypeName(propName)}`),
            true,
            toValidTypeName(propName),
            /*qualify*/ !!qualifyOpsRefs,
            collectAuxIR,
          );
          // No string/regex fallbacks; additionalProperties hoisting handles value aux creation.
          const { rendered, attr } = toValidResFieldName(propName);
          let name = rendered;
          let i = 2;
          while (used.has(name)) name = `${rendered}__${i++}`;
          used.add(name);
          const isReq = required.has(propName);
          const pdoc = wrapBlockDoc(propSchema.description);
          // Optionality handling with IR: option vs Nullable
          // In operation/local contexts, ensure component refs inside property types are fully qualified.
          // This avoids missing type errors (e.g., unqualified component enums) in aux records.
          const field: FieldIR = {
            name,
            attr: attr ?? undefined,
            typ: qualifyOpsRefs ? qualifyComponentRefsIR(pIR) : pIR,
          };
          if (!isReq) {
            if (optionalAsOption) {
              const inner = unwrapNull(pIR);
              if (inner) {
                field.typ = appIR(refIR("Nullable.t"), [inner]);
              } else {
                field.optional = "option";
              }
            } else {
              field.optional = "questionMark";
            }
          }
          {
            const fb = docForJSONFallback(field.typ);
            const combined = [propSchema.description as string | undefined, fb].filter(Boolean).join("\n");
            if (combined.length > 0) field.doc = wrapBlockDoc(combined);
            else if (pdoc) field.doc = pdoc;
          }
          fields.push(field);
        }
        // Second-chance hoist: ensure no inline record types remain directly on fields
        fields = fields.map((f) => {
          const newTyp = hoistFieldTypeIfNeeded(f.typ, collectAux, parentName, f.name, qualifyOpsRefs, collectAuxIR);
          return newTyp === f.typ ? f : { ...f, typ: newTyp };
        });
        // Second-chance hoist: ensure no inline record types remain directly on fields
        fields = fields.map((f) => {
          const newTyp = hoistFieldTypeIfNeeded(f.typ, collectAux, parentName, f.name, qualifyOpsRefs, collectAuxIR);
          return newTyp === f.typ ? f : { ...f, typ: newTyp };
        });
        // Build the record and qualify any component refs if we're in an operation context
        let recIR = recordIR(fields);
        if (qualifyOpsRefs) recIR = qualifyComponentRefsIR(recIR);
        if (s.nullable) {
          // Preserve hoisting behavior: avoid inline record inside Null.t by emitting an aux.
          const prepared = qualifyOpsRefs ? qualifyComponentRefsIR(recIR) : recIR;
          const printed = printTypeIR(prepared);
          const auxName = nameWithHash(toValidTypeName(`${parentName ?? "t"}__shape`), printed);
          if (typeof collectAuxIR === "function") {
            collectAuxIR(auxName, prepared);
            return appIR(refIR("Null.t"), [refIR(auxName)]);
          } else if (typeof collectAux === "function") {
            collectAux(auxName, printed);
            return appIR(refIR("Null.t"), [refIR(auxName)]);
          }
          return appIR(refIR("Null.t"), [recIR]);
        }
        return recIR;
      }
    }
  }
  // Fallback: emit unknown (nullable if needed)
  {
    let out: TypeIR = refIR("unknown");
    if (!isRef(schema)) {
      const s: any = schema as SchemaObject;
      if (s && s.nullable) out = appIR(refIR("Null.t"), [out]);
    }
    return out;
  }
}

function buildComponentsSchemas(
  components: ComponentsObject | undefined,
  ctx: RSContext
): RSNode {
  const schemasItems: RSNode[] = [];
  const postNodes: RSNode[] = [];
  // Track aux types emitted across all component schemas to avoid duplicates
  const emittedAuxGlobal = new Set<string>();

  const schemas = components?.schemas ?? {};
  const entries = getEntries(schemas, {
    alphabetize: ctx.alphabetize,
    excludeDeprecated: ctx.excludeDeprecated,
  });
  COMPONENT_SCHEMA_NAMES = new Set(entries.map(([name]) => toValidTypeName(name)));
  if (entries.length > 0) {
    const declNodes: RSNode[] = [];
    // Single aux scope for Components.Schemas to avoid collisions across components
    const initialUsed = entries.map(([n]) => toValidTypeName(n));
    const restore = CURRENT_AUX_SCOPE;
    CURRENT_AUX_SCOPE = { usedNames: new Set(initialUsed), nameToBody: new Map() };
    try {
      let emitted = 0;
      entries.forEach(([name, schema]) => {
      const kw: "type rec" | "and" = emitted === 0 ? "type rec" : "and";
      const typeName = toValidTypeName(name);
      // rsInclude gating: if selection is enabled and this schema name is not selected, skip emitting this type
      if (ctx.selectedSchemas && ctx.selectedSchemas.size >= 0 && !ctx.selectedSchemas.has(name)) {
        return;
      }
      const aux: Array<TypeDeclIR> = [];
      // Compose doc: include description + array constraints if present
      let topDoc = schema.description ?? undefined;
      const sObj = schema;
      if (sObj && typeof sObj === "object") {
        const notes: string[] = [];
        const hasArray =
          sObj.type === "array" ||
          ("prefixItems" in sObj && Array.isArray(sObj.prefixItems)) ||
          ("items" in sObj && Array.isArray(sObj.items));
        if (hasArray) {
          if ("minItems" in sObj && typeof sObj.minItems === "number")
            notes.push(`minItems: ${sObj.minItems}`);
          if ("maxItems" in sObj && typeof sObj.maxItems === "number")
            notes.push(`maxItems: ${sObj.maxItems}`);
          const pi =
            "prefixItems" in sObj && Array.isArray(sObj.prefixItems)
              ? sObj.prefixItems.length
              : "items" in sObj && Array.isArray(sObj.items)
                ? sObj.items.length
                : undefined;
          if (typeof pi === "number") notes.push(`prefixItems: ${pi}`);
        }
        // patternProperties regexes (doc note only)
        const patt =
          "patternProperties" in sObj ? sObj.patternProperties : undefined;
        if (patt && typeof patt === "object") {
          const patterns = Object.keys(patt);
          if (patterns.length > 0)
            notes.push(`pattern regexes: ${patterns.join(", ")}`);
        }
        if (notes.length > 0) {
          const line = `Constraints: ${notes.join("; ")}`;
          topDoc = topDoc ? `${topDoc}\n${line}` : line;
        }
      }
      // Reserve the top-level type name in this scope
      registerUsedTypeName(typeName);

      // Detect simple untagged unions at component level and emit ADT + alias + codecs
      const unionMembersTop = (schema as any).oneOf ?? (schema as any).anyOf;
      if (Array.isArray(unionMembersTop) && unionMembersTop.length > 0) {
        const union = detectSimpleUntaggedUnion(unionMembersTop as SchemaLike[], ctx, (schema as any).discriminator);
        if (union && (union as any).ok) {
          const adtName = toValidTypeName(`${typeName}_adt`);
          const aliasName = toValidTypeName(`${adtName}_wrapped`);
          // Reserve names to avoid collisions
          registerUsedTypeName(aliasName);
          registerUsedTypeName(adtName);
          // Emit top-level alias reference in the rec chain
          const doc = wrapBlockDoc(topDoc);
          declNodes.push({ kind: "type", keyword: kw, name: typeName, body: withDoc(doc, rawIR(aliasName)) });
          // Provide the abstract alias within the rec chain to avoid forward ref issues
          declNodes.push({ kind: "raw", code: `and ${aliasName}` });
          emitted++;
          // Build payload types per member
          const auxLocal: Array<TypeDeclIR> = [];
          const cases: Array<{ label: string; payload: TypeIR }> = [];
          for (let i = 0; i < (unionMembersTop as SchemaLike[]).length; i++) {
            const m = (unionMembersTop as SchemaLike[])[i]!;
            if (isRef(m)) {
              const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
              cases.push({ label: (union as any).labels[i]!, payload: refIR(rn) });
            } else {
              const payloadBase = toValidTypeName(`${typeName}_${(union as any).labels[i]}`);
              let irMem = mapSchemaToIR(m, ctx, {
                parentName: payloadBase,
                collectAux: (n, b) => {
                  const { doc, code } = splitDocBlock(b);
                  auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                },
                optionalAsOption: true,
              });
              irMem = hoistInlineRecordsIR(
                irMem,
                (n, b) => {
                  const { doc, code } = splitDocBlock(b);
                  auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                },
                payloadBase,
                true,
                undefined,
                /*qualify*/ false,
              );
              const printed = printTypeIR(irMem);
              const auxNm = nameWithHash(payloadBase, printed);
              auxLocal.push({ name: auxNm, body: irMem });
              cases.push({ label: (union as any).labels[i]!, payload: refIR(auxNm) });
            }
          }
          if ((union as any).allowUnknown) cases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
          if (auxLocal.length > 0) {
            for (const t of auxLocal) {
              if (!emittedAuxGlobal.has(t.name)) {
                postNodes.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                emittedAuxGlobal.add(t.name);
              }
            }
          }
          // Emit ADT and sibling decoder/encoder modules after rec chain
          postNodes.push({ kind: "attr", code: '@tag("kind")' });
          postNodes.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
          // Decoder + Encoder
          type StepC = { kind: "literal"; prop: string } | { kind: "keys" };
          const stepsC: StepC[] = [];
          const seenLitPropsC = new Set<string>();
          const litMapC = new Map<string, Array<{ value: string; label: string }>>();
          let sawKeysC = false;
          const keyPairsC: Array<{ prop: string; label: string }> = [];
          for (let i = 0; i < (union as any).signals.length; i++) {
            const sig = (union as any).signals[i]! as any;
            const label = (union as any).labels[i]!;
            if (sig.kind === "literal") {
              const arr = litMapC.get(sig.prop) ?? [];
              arr.push({ value: String(sig.value), label });
              litMapC.set(sig.prop, arr);
              if (!seenLitPropsC.has(sig.prop)) { stepsC.push({ kind: "literal", prop: sig.prop }); seenLitPropsC.add(sig.prop); }
            } else {
              keyPairsC.push({ prop: sig.prop, label });
              if (!sawKeysC) { stepsC.push({ kind: "keys" }); sawKeysC = true; }
            }
          }
          const buildTailOptC = (): string => {
            let tail = (union as any).allowUnknown ? 'Some(UnionDecode.make("Unknown", json))' : 'None';
            for (let i = stepsC.length - 1; i >= 0; i--) {
              const st = stepsC[i]!;
              if (st.kind === "literal") {
                const arr = litMapC.get(st.prop) ?? [];
                const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                const mapLit = `dict{${parts}` + `}`;
                const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                tail = `${head}${tail}}`;
              } else {
                const parts = keyPairsC.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                const mapKey = `dict{${parts}` + `}`;
                const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                tail = `${head}${tail}}`;
              }
            }
            return tail;
          };
          const rsPrivC = [
            "%%private(",
            `let decode_: ${aliasName} => option<${adtName}> = json => {`,
            `  ${buildTailOptC()}`,
            `}`,
            ")",
          ].join("\n");
          const rsThrowC = [
            `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
            `  switch decode_(json) {`,
            `  | Some(v) => v`,
            `  | None => JsError.throwWithMessage("No matching union member")`,
            `  }`,
            `}`,
          ].join("\n");
          const rsResC = [
            `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
            `  switch decode_(json) {`,
            `  | Some(v) => Ok(v)`,
            `  | None => Error(#DecodeError("No matching union member"))`,
            `  }`,
            `}`,
          ].join("\n");
          const decDocC = wrapBlockDoc(
            [
              "Decoder for simple untagged union.",
              "Matching signals:",
              ...(union as any).signals.map((s: any, i: number) =>
                s.kind === "literal"
                  ? `- ${(union as any).labels[i]!}: ${s.prop} == ${s.value}`
                  : `- ${(union as any).labels[i]!}: has key ${s.prop}`
              ),
              (union as any).allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
            ].join("\n")
          );
          if (decDocC) postNodes.push({ kind: "raw", code: decDocC });
          const rsEncC = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\\n");
          postNodes.push({ kind: "module", name: toValidModuleName(adtName), items: [
            { kind: "raw", code: rsPrivC },
            { kind: "raw", code: rsThrowC },
            { kind: "raw", code: rsResC },
            { kind: "raw", code: rsEncC },
          ]});
          // Done with this schema entry
          return;
        } else if (union && !(union as any).ok) {
          // Ambiguous untagged union at components level → emit ADT + alias (encode-only)
          const adtName = toValidTypeName(`${typeName}_adt`);
          const aliasName = toValidTypeName(`${adtName}_wrapped`);
          registerUsedTypeName(aliasName);
          registerUsedTypeName(adtName);
          const ambDoc = wrapBlockDoc("Ambiguous untagged union: encode-only; no safe decoder (no unique discriminator). ");
          // Emit top-level alias reference in the rec chain with doc
          const docTop = wrapBlockDoc(topDoc);
          const aliasRefBody = withDoc(docTop, rawIR(aliasName));
          declNodes.push({ kind: "type", keyword: kw, name: typeName, body: aliasRefBody });
          // Provide the abstract alias within the rec chain
          if (ambDoc) declNodes.push({ kind: "raw", code: ambDoc });
          declNodes.push({ kind: "raw", code: `and ${aliasName}` });
          emitted++;
          const auxLocal: Array<TypeDeclIR> = [];
          const cases: Array<{ label: string; payload: TypeIR }> = [];
          for (let i = 0; i < (unionMembersTop as SchemaLike[]).length; i++) {
            const m = (unionMembersTop as SchemaLike[])[i]!;
            if (isRef(m)) {
              const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
              const lbl = toValidModuleName(rn ?? `Member${i + 1}`);
              cases.push({ label: lbl, payload: refIR(rn) });
            } else {
              const payloadBase = toValidTypeName(`${typeName}_member_${i + 1}`);
              let irMem = mapSchemaToIR(m, ctx, {
                parentName: payloadBase,
                collectAux: (n, b) => {
                  const { doc, code } = splitDocBlock(b);
                  auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                },
                optionalAsOption: true,
              });
              irMem = hoistInlineRecordsIR(
                irMem,
                (n, b) => {
                  const { doc, code } = splitDocBlock(b);
                  auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                },
                payloadBase,
                true,
                undefined,
                /*qualify*/ false,
              );
              const printed = printTypeIR(irMem);
              const auxNm = nameWithHash(payloadBase, printed);
              auxLocal.push({ name: auxNm, body: irMem });
              const lbl = toValidModuleName(`Member${i + 1}`);
              cases.push({ label: lbl, payload: refIR(auxNm) });
            }
          }
          if (ambDoc) postNodes.push({ kind: "raw", code: ambDoc });
          postNodes.push({ kind: "attr", code: '@tag("kind")' });
          // Emit a rec chain: ADT followed by aux payload types
          postNodes.push({ kind: "type", keyword: "type rec", name: adtName, body: adtIR(cases) });
          {
            const seenAux = new Set<string>();
            for (const t of auxLocal) {
              if (seenAux.has(t.name)) continue;
              postNodes.push({ kind: "type", keyword: "and", name: t.name, body: t.body });
              seenAux.add(t.name);
            }
          }
          // Codec with JSON.t decoders (casts)
          const rsCodecC = [
            `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
            `let decodeOrThrow: ${aliasName} => JSON.t = v => Obj.magic(v)`,
            `let decode: ${aliasName} => result<JSON.t, [> #DecodeError(string)]> = v => Ok(Obj.magic(v))`,
          ].join("\n");
          postNodes.push({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsCodecC } ] });
          return;
        }
      }

      let bodyIR = mapSchemaToIR(schema, ctx, {
        parentName: typeName,
        collectAux: (n, b) => {
          const { doc, code } = splitDocBlock(b);
          aux.push({ name: n, body: withDoc(doc, rawIR(code)) });
          COMPONENT_SCHEMA_NAMES.add(n);
        },
        optionalAsOption: true,
        collectAuxIR: (n2, bodyIR) => { aux.push({ name: n2, body: bodyIR }); COMPONENT_SCHEMA_NAMES.add(n2); },
        collectAuxDecl: (node) => { postNodes.push(node); },
      });
      // Run unified IR hoist to remove any inline records under wrappers in component bodies
      bodyIR = hoistInlineRecordsIR(
        bodyIR,
        (n, b) => {
          const { doc, code } = splitDocBlock(b);
          aux.push({ name: n, body: withDoc(doc, rawIR(code)) });
          COMPONENT_SCHEMA_NAMES.add(n);
        },
        typeName,
        true,
        undefined,
        /*qualify*/ false,
      );
      let bodyPrinted = printTypeIR(bodyIR).trim();
      // Final guard: avoid inline record under Null.t at top-level (formatter limitation)
      // If this slipped through structured mapping or a fallback, hoist it here.
      const mNullRec = bodyPrinted.match(/^\s*Null\.t<\s*(\{[\s\S]*\})\s*>\s*$/);
      if (mNullRec) {
        const recBody = mNullRec[1]!;
        const auxName = nameWithHash(toValidTypeName(`${typeName}__shape`), recBody);
        aux.push({ name: auxName, body: rawIR(recBody) });
        bodyIR = rawIR(`Null.t<${auxName}>`);
        bodyPrinted = printTypeIR(bodyIR).trim();
      }
      // Note: Final guard removed; hoisting must happen during traversal (stage 1)
      if (bodyPrinted === "unknown") {
        const extra = wrapBlockDoc(
          "TODO: unsupported or ambiguous schema; fell back to unknown"
        );
        if (extra)
          topDoc = topDoc
            ? `${topDoc}\n${extra.replace(/^\/\*\*|\*\/$/g, "").trim()}`
            : extra.replace(/^\/\*\*|\*\/$/g, "").trim();
      }
      const doc = wrapBlockDoc(topDoc);
      const firstBody: TypeIR = withDoc(doc, bodyIR);
      declNodes.push({ kind: "type", keyword: kw, name: typeName, body: firstBody });
      emitted++;
      if (aux.length > 0) {
        const seen = new Set<string>();
        for (const t of aux) {
          if (seen.has(t.name)) continue;
          if (emittedAuxGlobal.has(t.name)) continue;
          declNodes.push({ kind: "type", keyword: "and", name: t.name, body: t.body });
          seen.add(t.name);
          emittedAuxGlobal.add(t.name);
        }
      }
      });
    } finally {
      CURRENT_AUX_SCOPE = restore;
    }
    // Move any alias stubs (`and <aliasName>`) requested by nested mappings into the rec chain
    if (postNodes.length > 0) {
      const keep: RSNode[] = [];
      for (const n of postNodes) {
        if ((n as any).kind === "raw") {
          const code = (n as any).code as string;
          if (typeof code === "string" && /^\s*and\s+[A-Za-z_][A-Za-z0-9_]*/.test(code)) {
            declNodes.push(n);
            continue;
          }
        }
        keep.push(n);
      }
      (postNodes as any).length = 0;
      (postNodes as any).push(...keep);
    }

    // Expose all component-local type names (including aux and postNodes) for later qualification in Operations
    for (const n of declNodes) if ((n as any).kind === "type") COMPONENT_SCHEMA_NAMES.add((n as any).name);
    for (const n of postNodes) if ((n as any).kind === "type") COMPONENT_SCHEMA_NAMES.add((n as any).name);
    schemasItems.push(...declNodes);
    if (postNodes.length > 0) schemasItems.push(...postNodes);
  }

  // Headers aggregator submodule
  const headersItems: RSNode[] = [];
  const hdrs = components?.headers ?? {};
  const hdrEntries = Object.entries(hdrs);
  if (hdrEntries.length > 0) {
    const fields: FieldIR[] = [];
    for (const [name, headerLike] of hdrEntries) {
      const header: HeaderObject | undefined = isRef(headerLike)
        ? ctx.resolve<HeaderObject>(headerLike.$ref)
        : headerLike;
      let actualIR: TypeIR = refIR("string");
      if (header && typeof header === "object") {
        if (header.schema) actualIR = mapSchemaToIR(header.schema, ctx, {});
        else if (header.content && typeof header.content === "object") {
          const ents = Object.entries(header.content);
          const chosenEntry =
            ents.find(([k]) => k === "application/json") ?? ents[0];
          const chosen = chosenEntry?.[1];
          const chosenResolved =
            chosen && isRef(chosen)
              ? ctx.resolve<MediaTypeObject>(chosen.$ref)
              : chosen;
          if (chosenResolved && chosenResolved.schema)
            actualIR = mapSchemaToIR(chosenResolved.schema, ctx, {});
          else actualIR = rawIR("unknown");
        }
      }
      const fn = toValidResFieldName(name);
      const field: FieldIR = {
        name: fn.rendered,
        attr: fn.attr ?? undefined,
        // Headers are optional in outputs → option<string>
        typ: refIR("string"),
        optional: "option",
      };
      const printedActual = printTypeIR(actualIR);
      if (printedActual !== "string") {
        const doc = wrapBlockDoc(`actual: ${printedActual}`);
        if (doc) field.doc = doc;
      }
      fields.push(field);
    }
    const bodyIR = recordIR(fields);
    headersItems.push({ kind: "type", keyword: "type", name: "response", body: bodyIR });
  } else {
    headersItems.push({ kind: "type", keyword: "type", name: "response", body: rawIR("emptyObject") });
  }
  const componentsNode: RSNode = {
    kind: "module",
    name: "Components",
    items: [
      { kind: "module", name: "Schemas", items: schemasItems },
      { kind: "module", name: "Headers", items: headersItems },
    ],
  };
  return componentsNode;
}

export function emitReScript(schema: OpenAPI3, ctx: RSContext): string {
  const file: RSNode[] = [];
  // header doc
  file.push({ kind: "comment", code: COMMENT_HEADER.trimEnd() });
  // global attrs and opens
  file.push({ kind: "attr", code: '@@warning("-30")' });
  // Suppress "unused open" (33) in large aggregated outputs where some opens are intentionally redundant
  file.push({ kind: "attr", code: '@@warning("-33")' });
  file.push({ kind: "open", name: "OpenAPIFetch" });
  file.push({ kind: "blank" });

  // rsInclude: compute selection and emit placeholder type when enabled
  if (ctx.rsIncludeEnabled) {
    const sel = computeSelectedSchemas(schema, ctx);
    if (sel) ctx.selectedSchemas = sel;
    const note = wrapBlockDoc(
      [
        "Placeholder for filtered out entities.",
        "To generate these, configure rsInclude (paths and/or components.schemas)",
        "so that the desired paths/schemas are included, or remove rsInclude",
        "to emit the full schema.",
      ].join("\n")
    );
    // Emit an abstract placeholder type with a doc comment
    const decl = [note, "type not_generated"].filter(Boolean).join("\n");
    file.push({ kind: "raw", code: decl });
    file.push({ kind: "blank" });
  }

  // Components
  file.push(buildComponentsSchemas(schema.components, ctx));
  // Operations (now via IR)
  file.push(buildOperations(schema.paths, schema.webhooks, ctx));

  // Paths & Client types (now via IR)
  const { nodes: pathNodes, hasClient } = buildPaths(schema.paths, ctx);
  if (pathNodes.length > 0) file.push(...pathNodes);
  if (hasClient) {
    const clientDoc = wrapBlockDoc(
      [
        "Client setup and security:",
        "- Provide auth via createClient options (headers, fetch, Request).",
        '- Bearer token: headers = {"Authorization": "Bearer <token>"}.',
        '- API key (header): headers = {"X-API-Key": "<key>"}.',
        "- API key (query): pass via params.query per call or middleware.",
        "- OAuth2: inject Bearer tokens via headers or middleware.",
        "- You can register middleware with Client.use to set headers per request.",
        "- Security requirements in the schema are informational; types don't enforce auth.",
      ].join("\n")
    );
    if (clientDoc) file.push({ kind: "raw", code: "\n" + clientDoc });
    file.push({ kind: "attr", code: '@module("openapi-fetch")' });
    file.push({
      kind: "raw",
      code:
        'external createClient: createClientOptions => Client.clientContainer<client> = "createClient"',
    });
    file.push({ kind: "blank" });
    const createClientBody = [
      "let createClient = options => {",
      "  let c = createFetchClient(createClient(options))",
      "  c",
      "}",
    ].join("\n");
    file.push({ kind: "raw", code: createClientBody });
    file.push({ kind: "blank" });
  }

  // Webhooks types (now via IR)
  const { nodes: webhookNodes } = buildWebhooks(schema.webhooks, ctx);
  if (webhookNodes.length > 0) file.push(...webhookNodes);

  // Callbacks types (now via IR)
  const { nodes: callbackNodes } = buildCallbacks(schema.paths, ctx);
  if (callbackNodes.length > 0) file.push(...callbackNodes);

  return printFile(file);
}

function resolveOperation(
  op: OperationObject | ReferenceObject | undefined,
  ctx: RSContext
): OperationObject | undefined {
  if (!op) return undefined;
  if ("$ref" in op) {
    return ctx.resolve<OperationObject>(op.$ref);
  }
  return op;
}

function buildOperations(
  paths: PathsObject | undefined,
  webhooks: OpenAPI3["webhooks"] | undefined,
  ctx: RSContext
): RSNode {
  const opsItems: RSNode[] = [];

  const METHODS: (keyof PathItemObject)[] = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];

  const emitForContainer = (
    container?: Record<string, PathItemObject | ReferenceObject> | undefined,
    enforceIncludePaths: boolean = false
  ) => {
    if (!container) return;
    for (const [p, item] of Object.entries(container)) {
      if (enforceIncludePaths && (ctx.includePaths || ctx.includePathPrefixes) && !pathIsIncluded(p, ctx)) continue;
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        const opName = opId && opId.length > 0 ? opId : `${String(p)}_${String(m)}`;
        const mod = toValidModuleName(opName);
        const modItems: RSNode[] = [];
        // New aux naming scope for this operation module
        const __prevScope = CURRENT_AUX_SCOPE;
        CURRENT_AUX_SCOPE = { usedNames: new Set(["params", "parameters", "success", "error", "status"]), nameToBody: new Map() };
        // Open Components.Schemas so unqualified component refs in op-local aux types resolve
        modItems.push({ kind: "open", name: "Components.Schemas" });

        // Security requirements doc
        const secReq = op.security as Array<Record<string, string[]>> | undefined;
        if (Array.isArray(secReq) && secReq.length > 0) {
          const parts: string[] = [];
          for (const req of secReq) {
            for (const [scheme, scopes] of Object.entries(req)) {
              const list = scopes.length > 0 ? ` [${scopes.join(", ")}]` : "";
              parts.push(`${scheme}${list}`);
            }
          }
          const doc = wrapBlockDoc(parts.length > 0 ? `security: ${parts.join("; ")}` : undefined);
          if (doc) modItems.push({ kind: "raw", code: doc });
        }

        // PARAMETERS
        const allParams: Array<import("../types.js").ParameterObject | ReferenceObject> = [];
        const pathParams = isRef(item) ? undefined : item.parameters;
        if (Array.isArray(pathParams)) allParams.push(...pathParams);
        const opParams = op.parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
        if (Array.isArray(opParams)) allParams.push(...opParams);

        type GroupKey = "query" | "header" | "path" | "cookie";
        const groups: Record<GroupKey, FieldIR[]> = { query: [], header: [], path: [], cookie: [] };
        const paramAux: Array<TypeDeclIR> = [];
        const present: Set<GroupKey> = new Set();
        for (const pp of allParams) {
          const param = isRef(pp)
            ? ctx.resolve<import("../types.js").ParameterObject>(pp.$ref)
            : pp;
          if (!param) continue;
          const where = param.in;
          const name = param.name;
          if (!where || !name) continue;
          const required = !!param.required;
          const schema = param.schema;
          let pIR: TypeIR = rawIR("unknown");
          if (schema) {
            const base = toValidTypeName(`${mod}_${where}_${toValidTypeName(name)}`);
                  let ir = mapSchemaToIR(schema, ctx, {
                    parentName: base,
                    collectAux: (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                    qualifyOpsRefs: true,
                    collectAuxIR: (n2, bodyIR) => { paramAux.push({ name: n2, body: bodyIR }); },
                    collectAuxDecl: (node) => { modItems.push(node); },
                  });
            ir = hoistFieldTypeIfNeeded(
              ir,
              (n, b) => {
                const { doc, code } = splitDocBlock(b);
                paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
              },
              base,
              toValidTypeName(name),
              true,
              (n2, bodyIR) => { paramAux.push({ name: n2, body: bodyIR }); },
            );
            pIR = qualifyComponentRefsIR(ir);
          }
          const fname = toValidResFieldName(name);
          const pdoc = wrapBlockDoc(param.description);
          const field: FieldIR = {
            name: fname.rendered,
            attr: fname.attr ?? undefined,
            typ: pIR,
            // Input context (parameters): use questionMark optional, not option<…>
            optional: required ? undefined : "questionMark",
          };
          if (pdoc) field.doc = pdoc;
          groups[where].push(field);
          present.add(where);
        }

        const fieldOrder: GroupKey[] = ["query", "header", "path", "cookie"];
        if (paramAux.length > 0) {
          const seenParamAux = new Set<string>();
          for (const t of paramAux) {
            if (seenParamAux.has(t.name)) continue;
            modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
            seenParamAux.add(t.name);
          }
        }
        for (const k of fieldOrder) {
          if (!present.has(k)) continue;
          const body = groups[k];
          modItems.push({ kind: "type", keyword: "type", name: k, body: recordIR(body) });
        }
        if (present.size > 0) {
          const paramsFields: FieldIR[] = [];
          for (const k of fieldOrder) {
            if (!present.has(k)) continue;
            const target = toValidResFieldName(k);
            paramsFields.push({
              name: target.rendered,
              attr: target.attr ?? undefined,
              typ: refIR(k),
              // Input context: use questionMark (query?: query, etc.)
              optional: "questionMark",
            });
          }
          const paramsBody = recordIR(paramsFields);
          modItems.push({ kind: "type", keyword: "type", name: "params", body: paramsBody });
        }

        // REQUEST BODY (IR)
        let bodyType: string | undefined;
        let bodyFieldDoc: string | undefined;
        const rb = op.requestBody;
        if (rb) {
          const req = isRef(rb) ? ctx.resolve<RequestBodyObject>(rb.$ref) : rb;
          const content = req && req.content && typeof req.content === "object" ? req.content : undefined;
          if (content) {
            const entries = Object.entries(content);
            let chosen: MediaTypeObject | ReferenceObject | undefined = undefined;
            let chosenKey: string | undefined = undefined;
            for (const [k, v] of entries) {
              if (k === "application/json") {
                chosen = v;
                chosenKey = k;
                break;
              }
            }
            if (!chosen && entries.length === 1) {
              chosen = entries[0]![1];
              chosenKey = entries[0]![0];
            }
            if (!chosen && entries.length > 1) {
              // Fallback to first entry when multiple types exist
              chosen = entries[0]![1];
              chosenKey = entries[0]![0];
            }
            // If multiple content types exist, attach a doc listing alternatives
            if (entries.length > 1 && chosenKey) {
              const alts = entries.map(([k]) => k).filter((k) => k !== chosenKey);
              const doc = wrapBlockDoc(`accepts: ${alts.join(", ")}`);
              if (doc) bodyFieldDoc = doc;
            }
            const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
            if (chosenResolved && chosenResolved.schema) {
              // Detect simple untagged union for request body and emit ADT + alias + codec
              const union = ((): SimpleUnionDetection | undefined => {
                const sch = isRef(chosenResolved!.schema) ? ctx.resolve<SchemaObject>((chosenResolved!.schema as any).$ref) : (chosenResolved!.schema as any);
                if (!sch) return undefined;
                const members = (sch as any).oneOf ?? (sch as any).anyOf;
                if (Array.isArray(members) && members.length > 0) return detectSimpleUntaggedUnion(members as SchemaLike[], ctx, (sch as any).discriminator);
                return undefined;
              })();

              if (union && union.ok) {
                const adtName = toValidTypeName(`${mod}_request_body_data`);
                const aliasName = toValidTypeName(`${adtName}_wrapped`);
                const cases: Array<{ label: string; payload: TypeIR }> = [];
                const auxLocal: Array<TypeDeclIR> = [];
                const members = ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).oneOf ?? ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).anyOf;
                for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                  const m = (members as SchemaLike[])[i]!;
                  if (isRef(m)) {
                    const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                    cases.push({ label: union.labels[i]!, payload: qualifyComponentRefsIR(refIR(rn)) });
                  } else {
                    const payloadBase = toValidTypeName(`${adtName}_${union.labels[i]}`);
                let irMem = mapSchemaToIR(m, ctx, {
                  parentName: payloadBase,
                  collectAux: (n, b) => {
                    const { doc, code } = splitDocBlock(b);
                    auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                  },
                  optionalAsOption: true,
                  qualifyOpsRefs: true,
                  collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                });
                    irMem = hoistInlineRecordsIR(
                      irMem,
                      (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                      payloadBase,
                      true,
                      undefined,
                      /*qualify*/ true,
                      (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                    );
                    irMem = qualifyComponentRefsIR(irMem);
                    const printed = printTypeIR(irMem);
                    const auxNm = nameWithHash(payloadBase, printed);
                    auxLocal.push({ name: auxNm, body: irMem });
                    cases.push({ label: union.labels[i]!, payload: refIR(auxNm) });
                  }
                }
                if (auxLocal.length > 0) {
                  const seenAux = new Set<string>();
                  for (const t of auxLocal) {
                    if (seenAux.has(t.name)) continue;
                    modItems.push({ kind: "type", keyword: "type", name: t.name, body: qualifyComponentRefsIR(t.body) });
                    seenAux.add(t.name);
                  }
                }
                if (union.allowUnknown) cases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
                // Emit ADT and alias + codec module
                modItems.push({ kind: "attr", code: '@tag("kind")' });
                modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                const codecModName = toValidModuleName(adtName);
                const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                // Decoder module
                type Step = { kind: "literal"; prop: string } | { kind: "keys" };
                const steps: Step[] = [];
                const seenLitProps = new Set<string>();
                const litMap = new Map<string, Array<{ value: string; label: string }>>();
                let sawKeys = false;
                const keyPairs: Array<{ prop: string; label: string }> = [];
                for (let i = 0; i < union.signals.length; i++) {
                  const sig = union.signals[i]! as any;
                  const label = union.labels[i]!;
                  if (sig.kind === "literal") {
                    const arr = litMap.get(sig.prop) ?? [];
                    arr.push({ value: String(sig.value), label });
                    litMap.set(sig.prop, arr);
                    if (!seenLitProps.has(sig.prop)) { steps.push({ kind: "literal", prop: sig.prop }); seenLitProps.add(sig.prop); }
                  } else {
                    keyPairs.push({ prop: sig.prop, label });
                    if (!sawKeys) { steps.push({ kind: "keys" }); sawKeys = true; }
                  }
                }
                const buildTailOpt = (): string => {
                  let tail = union.allowUnknown ? 'Some(UnionDecode.make("Unknown", json))' : 'None';
                  for (let i = steps.length - 1; i >= 0; i--) {
                    const st = steps[i]!;
                    if (st.kind === "literal") {
                      const arr = litMap.get(st.prop) ?? [];
                      const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                      const mapLit = `dict{${parts}}`;
                      const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                      tail = `${head}${tail}}`;
                    } else {
                      const parts = keyPairs.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                      const mapKey = `dict{${parts}}`;
                      const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                      tail = `${head}${tail}}`;
                    }
                  }
                  return tail;
                };
                const rsPriv = [
                  "%%private(",
                  `let decode_: ${aliasName} => option<${adtName}> = json => {`,
                  `  ${buildTailOpt()}`,
                  `}`,
                  ")",
                ].join("\n");
                const rsThrow = [
                  `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
                  `  switch decode_(json) {`,
                  `  | Some(v) => v`,
                  `  | None => JsError.throwWithMessage("No matching union member")`,
                  `  }`,
                  `}`,
                ].join("\n");
                const rsRes = [
                  `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
                  `  switch decode_(json) {`,
                  `  | Some(v) => Ok(v)`,
                  `  | None => Error(#DecodeError("No matching union member"))`,
                  `  }`,
                  `}`,
                ].join("\n");
                const decDoc = wrapBlockDoc(
                  [
                    "Decoder for simple untagged union.",
                    "Matching signals:",
                    ...union.signals.map((s, i) => s.kind === "literal" ? `- ${union.labels[i]!}: ${s.prop} == ${s.value}` : `- ${union.labels[i]!}: has key ${s.prop}`),
                    union.allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
                  ].join("\n")
                );
                if (decDoc) modItems.push({ kind: "raw", code: decDoc });
                const rsEncode = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
                modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [
                  { kind: "raw", code: rsPriv },
                  { kind: "raw", code: rsThrow },
                  { kind: "raw", code: rsRes },
                  { kind: "raw", code: rsEncode },
                ]});
                // Also emit an Encoder_ module that enforces literal discriminators during encoding
                {
                  const encLines: string[] = [];
                  if (union.allowUnknown) encLines.push(`  | Unknown(x) => Obj.magic(x)`);
                  for (let i = 0; i < union.labels.length; i++) {
                    const label = union.labels[i]!;
                    const sig = union.signals[i]! as any;
                    if (sig.kind === "literal") {
                      encLines.push(`  | ${label}(x) => Obj.magic(UnionEncode.ensureLiteral(x, ${JSON.stringify(sig.prop)}, ${JSON.stringify(String(sig.value))}))`);
                    } else {
                      encLines.push(`  | ${label}(x) => Obj.magic(x)`);
                    }
                  }
                  const rsEncode2 = [
                    `let encode: ${adtName} => ${aliasName} = v => {`,
                    `  switch v {`,
                    ...encLines,
                    `  }`,
                    `}`,
                  ].join("\n");
                  modItems.push({ kind: "module", name: `Encoder_${toValidModuleName(adtName)}`, items: [
                    { kind: "raw", code: rsEncode2 },
                  ]});
                }
                bodyType = aliasName;
              } else if (union && !union.ok) {
                // Ambiguous untagged union in request body → emit ADT + alias (encode-only)
                const adtName = toValidTypeName(`${mod}_request_body_data`);
                const aliasName = toValidTypeName(`${adtName}_wrapped`);
                const cases: Array<{ label: string; payload: TypeIR }> = [];
                const auxLocal: Array<TypeDeclIR> = [];
                const members = ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).oneOf ?? ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).anyOf;
                for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                  const m = (members as SchemaLike[])[i]!;
                  if (isRef(m)) {
                    const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                    const lbl = toValidModuleName(rn ?? `Member${i + 1}`);
                    cases.push({ label: lbl, payload: qualifyComponentRefsIR(refIR(rn)) });
                  } else {
                    const payloadBase = toValidTypeName(`${adtName}_member_${i + 1}`);
                    let irMem = mapSchemaToIR(m, ctx, {
                      parentName: payloadBase,
                      collectAux: (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                      optionalAsOption: true,
                      qualifyOpsRefs: true,
                      collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                    });
                    irMem = hoistInlineRecordsIR(
                      irMem,
                      (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                      payloadBase,
                      true,
                      undefined,
                      /*qualify*/ true,
                      (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                    );
                    irMem = qualifyComponentRefsIR(irMem);
                    const printed = printTypeIR(irMem);
                    const auxNm = nameWithHash(payloadBase, printed);
                    auxLocal.push({ name: auxNm, body: irMem });
                    const lbl = toValidModuleName(`Member${i + 1}`);
                    cases.push({ label: lbl, payload: refIR(auxNm) });
                  }
                }
                if (auxLocal.length > 0) {
                  const seenAux = new Set<string>();
                  for (const t of auxLocal) {
                    if (seenAux.has(t.name)) continue;
                    modItems.push({ kind: "type", keyword: "type", name: t.name, body: qualifyComponentRefsIR(t.body) });
                    seenAux.add(t.name);
                  }
                }
                const ambDoc = wrapBlockDoc("Ambiguous untagged union: encode-only; no safe decoder (no unique discriminator). ");
                if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                modItems.push({ kind: "attr", code: '@tag("kind")' });
                modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                const codecModName = toValidModuleName(adtName);
                if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                const rsCodec = [
                  `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
                  `let decodeOrThrow: ${aliasName} => JSON.t = v => Obj.magic(v)`,
                  `let decode: ${aliasName} => result<JSON.t, [> #DecodeError(string)]> = v => Ok(Obj.magic(v))`,
                ].join("\n");
                modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsCodec } ] });
                bodyType = aliasName;
              } else {
                const aux: Array<TypeDeclIR> = [];
                const base = toValidTypeName(`${mod}_request_body`);
                let ir = mapSchemaToIR(chosenResolved.schema, ctx, {
                  parentName: base,
                  optionalAsOption: true,
                  qualifyOpsRefs: true,
                  collectAuxIR: (n2, bodyIR) => { aux.push({ name: n2, body: bodyIR }); },
                  collectAuxDecl: (node) => { modItems.push(node); },
                });
                ir = hoistInlineRecordsIR(
                  ir,
                  undefined,
                  base,
                  true,
                  undefined,
                  /*qualify*/ true,
                  (n2, bodyIR) => { aux.push({ name: n2, body: bodyIR }); },
                );
                ir = qualifyComponentRefsIR(ir);
                if (aux.length > 0) {
                  const seenReqAux = new Set<string>();
                  for (const t of aux) {
                    if (seenReqAux.has(t.name)) continue;
                    modItems.push({ kind: "type", keyword: "type", name: t.name, body: qualifyComponentRefsIR(t.body) });
                    seenReqAux.add(t.name);
                  }
                }
                // No string or regex fallbacks; value aux creation is handled when mapping additionalProperties.
                // If record, declare named type; otherwise inline printed IR
                if (ir.kind === "record" || (ir.kind === "withDoc" && ir.inner.kind === "record")) {
                  modItems.push({ kind: "type", keyword: "type", name: base, body: ir });
                  bodyType = base;
                } else {
                  bodyType = printTypeIR(ir);
                }
              }
            } else {
              bodyType = "JSON.t";
            }
          }
        }

        // PARAMETERS wrapper (IR)
        const parametersFieldsIR: FieldIR[] = [];
        if (present.size > 0) parametersFieldsIR.push({ name: "params", typ: refIR("params"), optional: "questionMark" });
        if (bodyType) parametersFieldsIR.push({ name: "body", typ: rawIR(bodyType), optional: "questionMark", doc: bodyFieldDoc });
        // Per-call overrides: headers and baseUrl (input context → questionMark)
        parametersFieldsIR.push({ name: "headers", typ: appIR(refIR("dict"), [refIR("string")]), optional: "questionMark" });
        parametersFieldsIR.push({ name: "baseUrl", typ: refIR("string"), optional: "questionMark" });
        if (parametersFieldsIR.length > 0) {
          const pBody = recordIR(parametersFieldsIR);
          modItems.push({ kind: "type", keyword: "type", name: "parameters", body: pBody });
        } else {
          modItems.push({ kind: "type", keyword: "type", name: "parameters", body: rawIR("emptyObject") });
        }

        // RESPONSES
        const responses = op.responses;
        const successVariants: Array<{ label: string; payload: TypeIR; attr?: string }> = [];
        const successPayloadTypes: string[] = [];
        const successStatusCodes: string[] = [];
        const errorVariants: Array<{ label: string; payload: TypeIR; attr?: string }> = [];
        const usedSuccessCtors: Set<string> = new Set();
        const usedErrorCtors: Set<string> = new Set();
        const auxTypes: TypeDeclIR[] = [];
        const successAuxTypes: TypeDeclIR[] = [];
        const variantAuxTypes: TypeDeclIR[] = [];
        const headerTypeDefs: TypeDeclIR[] = [];

        const addAuxType = (name: string, body: string) => {
          if (!auxTypes.some((t) => t.name === name)) {
            const { doc, code } = splitDocBlock(body);
            auxTypes.push({ name, body: withDoc(doc, rawIR(code)) });
          }
        };
        const addSuccessAuxType = (name: string, body: string) => {
          if (!successAuxTypes.some((t) => t.name === name)) {
            const { doc, code } = splitDocBlock(body);
            successAuxTypes.push({ name, body: withDoc(doc, rawIR(code)) });
          }
        };

        // Track presence of a default response for doc/helper emission
        let __hasDefault = false;
        if (responses && typeof responses === "object") {
          // Collect success bodies
      const bodies: { code: string; ty: string }[] = [];
      for (const [status, respLike] of Object.entries(responses)) {
            const isDefault = status === "default";
            const n = parseInt(status, 10);
            const is2xx = !isNaN(n) && n >= 200 && n < 300;
            if (isDefault) __hasDefault = true;
            const refNameForCtor = ((): string | undefined => {
              if (isRef(respLike)) {
                const nm = refName(respLike.$ref);
                if (nm) return nm[0]!.toUpperCase() + nm.slice(1);
              }
              return undefined;
            })();
            const resolved = isRef(respLike) ? ctx.resolve<ResponseObject>(respLike.$ref) : respLike;
            const content = resolved && typeof resolved === "object" ? resolved.content : undefined;
            let payload: string | undefined;
            let unknownReason: string | undefined;
            let noContent: boolean = false;
            if (content && typeof content === "object") {
              const entries = Object.entries(content);
              let chosen: MediaTypeObject | undefined = undefined;
              for (const [k, v] of entries) {
                if (k === "application/json") {
                  chosen = v;
                  break;
                }
              }
              if (!chosen && entries.length === 1) chosen = entries[0]![1];
              if (chosen && chosen.schema) {
                const base = toValidTypeName(`status_${status}_body`);
                const union = ((): SimpleUnionDetection | undefined => {
                  const sch = isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any);
                  if (!sch) return undefined;
                  const members = (sch as any).oneOf ?? (sch as any).anyOf;
                  if (Array.isArray(members) && members.length > 0) return detectSimpleUntaggedUnion(members as SchemaLike[], ctx, (sch as any).discriminator);
                  return undefined;
                })();

                // If simple untagged union detected, emit ADT + alias + decoder and use alias as payload type
                if (union && union.ok) {
                  const adtName = toValidTypeName(`status_${status}_result_data`);
                  const aliasName = toValidTypeName(`${adtName}_wrapped`);
                  // Build payload types per member
                  const cases: Array<{ label: string; payload: TypeIR }> = [];
                  const auxLocal: Array<TypeDeclIR> = [];
                  const members = ((isRef(chosen.schema) ? ctx.resolve<SchemaObject>((chosen.schema as any).$ref) : (chosen.schema as any)) as any).oneOf ?? ((isRef(chosen.schema) ? ctx.resolve<SchemaObject>((chosen.schema as any).$ref) : (chosen.schema as any)) as any).anyOf;
                  for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                    const m = (members as SchemaLike[])[i]!;
                    if (isRef(m)) {
                      const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                      cases.push({ label: union.labels[i]!, payload: qualifyComponentRefsIR(refIR(rn)) });
                    } else {
                      const payloadBase = toValidTypeName(`${adtName}_${union.labels[i]}`);
                    let irMem = mapSchemaToIR(m, ctx, {
                      parentName: payloadBase,
                      collectAux: (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                      optionalAsOption: true,
                      qualifyOpsRefs: true,
                      collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                    });
                      irMem = hoistInlineRecordsIR(
                        irMem,
                        (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        payloadBase,
                        true,
                        undefined,
                        /*qualify*/ true,
                        (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                      );
                      irMem = qualifyComponentRefsIR(irMem);
                      const printed = printTypeIR(irMem);
                      const auxNm = nameWithHash(payloadBase, printed);
                      auxLocal.push({ name: auxNm, body: irMem });
                      cases.push({ label: union.labels[i]!, payload: refIR(auxNm) });
                    }
                  }
                  if (auxLocal.length > 0) {
                    for (const t of auxLocal) modItems.push({ kind: "type", keyword: "type", name: t.name, body: qualifyComponentRefsIR(t.body) });
                  }
                  if (union.allowUnknown) {
                    cases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
                  }
                  // Emit ADT next to aux types
                  modItems.push({ kind: "attr", code: '@tag("kind")' });
                  modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                  // Alias wrapped with editor completion hint
                  const codecModName = toValidModuleName(adtName);
                  const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                  modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                  // Decoder module built with UnionDecode helpers
                  // Group signals to minimize calls: one chooseByKeys for all key signals,
                  // and one chooseByLiteral per property for literal signals.
                  type Step = { kind: "literal"; prop: string } | { kind: "keys" };
                  const steps: Step[] = [];
                  const seenLitProps = new Set<string>();
                  const litMap = new Map<string, Array<{ value: string; label: string }>>();
                  let sawKeys = false;
                  const keyPairs: Array<{ prop: string; label: string }> = [];
                  for (let i = 0; i < union.signals.length; i++) {
                    const sig = union.signals[i]! as any;
                    const label = union.labels[i]!;
                    if (sig.kind === "literal") {
                      const arr = litMap.get(sig.prop) ?? [];
                      arr.push({ value: String(sig.value), label });
                      litMap.set(sig.prop, arr);
                      if (!seenLitProps.has(sig.prop)) {
                        steps.push({ kind: "literal", prop: sig.prop });
                        seenLitProps.add(sig.prop);
                      }
                    } else {
                      keyPairs.push({ prop: sig.prop, label });
                      if (!sawKeys) {
                        steps.push({ kind: "keys" });
                        sawKeys = true;
                      }
                    }
                  }
                  const buildTail = (kind: "throw" | "result"): string => {
                    let tail = kind === "throw"
                      ? (union.allowUnknown ? 'UnionDecode.make("Unknown", json)' : 'JsError.throwWithMessage("No matching union member")')
                      : (union.allowUnknown ? 'Ok(UnionDecode.make("Unknown", json))' : 'Error(#DecodeError("No matching union member"))');
                    for (let i = steps.length - 1; i >= 0; i--) {
                      const st = steps[i]!;
                      if (st.kind === "literal") {
                        const arr = litMap.get(st.prop) ?? [];
                        const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapLit = `dict{${parts}}`;
                        const head = kind === "throw"
                          ? `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => UnionDecode.make(l, json) | None => `
                          : `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Ok(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      } else {
                        const parts = keyPairs.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapKey = `dict{${parts}}`;
                        const head = kind === "throw"
                          ? `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => UnionDecode.make(l, json) | None => `
                          : `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Ok(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      }
                    }
                    return tail;
                  };
                  const buildTailOption = (): string => {
                    let tail = union.allowUnknown
                      ? 'Some(UnionDecode.make("Unknown", json))'
                      : 'None';
                    for (let i = steps.length - 1; i >= 0; i--) {
                      const st = steps[i]!;
                      if (st.kind === "literal") {
                        const arr = litMap.get(st.prop) ?? [];
                        const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapLit = `dict{${parts}}`;
                        const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      } else {
                        const parts = keyPairs.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapKey = `dict{${parts}}`;
                        const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      }
                    }
                    return tail;
                  };
                  const rsPrivate = [
                    "%%private(",
                    `let decode_: ${aliasName} => option<${adtName}> = json => {`,
                    `  ${buildTailOption()}`,
                    `}`,
                    ")",
                  ].join("\n");
                  const rsThrow = [
                    `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
                    `  switch decode_(json) {`,
                    `  | Some(v) => v`,
                    `  | None => JsError.throwWithMessage("No matching union member")`,
                    `  }`,
                    `}`,
                  ].join("\n");
                  const rsResult = [
                    `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
                    `  switch decode_(json) {`,
                    `  | Some(v) => Ok(v)`,
                    `  | None => Error(#DecodeError("No matching union member"))`,
                    `  }`,
                    `}`,
                  ].join("\n");
                  const decDoc = wrapBlockDoc(
                    [
                      "Decoder for simple untagged union.",
                      "Matching signals:",
                      ...union.signals.map((s, i) =>
                        s.kind === "literal"
                          ? `- ${union.labels[i]!}: ${s.prop} == ${s.value}`
                          : `- ${union.labels[i]!}: has key ${s.prop}`
                      ),
                      union.allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
                    ].join("\n")
                  );
                  if (decDoc) modItems.push({ kind: "raw", code: decDoc });
                  const rsEncode = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
                  modItems.push({ kind: "module", name: codecModName, items: [
                    { kind: "raw", code: rsPrivate },
                    { kind: "raw", code: rsThrow },
                    { kind: "raw", code: rsResult },
                    { kind: "raw", code: rsEncode },
                  ]});
                  payload = aliasName;
                } else if (union && !union.ok) {
                  // Ambiguous untagged union → emit ADT + alias in a rec chain (encode-only), no JSON.t fallback
                  const adtName = toValidTypeName(`status_${status}_result_data`);
                  const aliasName = toValidTypeName(`${adtName}_wrapped`);
                  const cases: Array<{ label: string; payload: TypeIR }> = [];
                  const auxLocal: Array<TypeDeclIR> = [];
                  const members = ((isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any)) as any).oneOf ?? ((isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any)) as any).anyOf;
                  for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                    const m = (members as SchemaLike[])[i]!;
                    if (isRef(m)) {
                      const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                      const lbl = toValidModuleName(rn ?? `Member${i + 1}`);
                      cases.push({ label: lbl, payload: qualifyComponentRefsIR(refIR(rn)) });
                    } else {
                      const payloadBase = toValidTypeName(`${adtName}_member_${i + 1}`);
                      let irMem = mapSchemaToIR(m, ctx, {
                        parentName: payloadBase,
                        collectAux: (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        optionalAsOption: true,
                        qualifyOpsRefs: true,
                        collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                      });
                      irMem = hoistInlineRecordsIR(
                        irMem,
                        (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        payloadBase,
                        true,
                        undefined,
                        /*qualify*/ true,
                        (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                      );
                      irMem = qualifyComponentRefsIR(irMem);
                      const printed = printTypeIR(irMem);
                      const auxNm = nameWithHash(payloadBase, printed);
                      auxLocal.push({ name: auxNm, body: irMem });
                      const lbl = toValidModuleName(`Member${i + 1}`);
                      cases.push({ label: lbl, payload: refIR(auxNm) });
                    }
                  }
                  // Doc + rec chain: ADT followed by aux types
                  const ambDoc = wrapBlockDoc("Ambiguous untagged union: encode-only; no safe decoder (no unique discriminator). ");
                  if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                  modItems.push({ kind: "attr", code: '@tag("kind")' });
                  modItems.push({ kind: "type", keyword: "type rec", name: adtName, body: adtIR(cases) });
                  // Append aux types as part of the rec chain
                  for (const t of auxLocal) {
                    if (!modItems.some((x) => x.kind === "type" && (x as any).name === t.name))
                      modItems.push({ kind: "type", keyword: "and", name: t.name, body: qualifyComponentRefsIR(t.body) });
                  }
                  const codecModName = toValidModuleName(adtName);
                  // Alias with editor hint and doc
                  if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                  const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                  modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                  // Encode-only codec module + decodeJSON passthrough
                  const rsCodec = [
                    `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
                    `let decodeJSON: ${aliasName} => JSON.t = v => Obj.magic(v)`,
                  ].join("\n");
                  modItems.push({ kind: "module", name: codecModName, items: [ { kind: "raw", code: rsCodec } ] });
                  payload = aliasName;
                } else {
                  // Default IR path
                  const auxLocal: Array<TypeDeclIR> = [];
                let ir = mapSchemaToIR(chosen.schema, ctx, {
                  parentName: base,
                  collectAux: (n, b) => {
                    const { doc, code } = splitDocBlock(b);
                    auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                  },
                  optionalAsOption: true,
                  qualifyOpsRefs: true,
                  collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                  collectAuxDecl: (node) => { modItems.push(node); },
                });
                  ir = hoistInlineRecordsIR(
                    ir,
                    (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                    base,
                    true,
                    undefined,
                    /*qualify*/ true,
                    (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                  );
                  ir = qualifyComponentRefsIR(ir);
                  if (auxLocal.length > 0) {
                    if (is2xx) {
                      for (const t of auxLocal) if (!successAuxTypes.some((x) => x.name === t.name)) successAuxTypes.push({ name: t.name, body: qualifyComponentRefsIR(t.body) });
                    } else if (!isDefault) {
                      for (const t of auxLocal) if (!auxTypes.some((x) => x.name === t.name)) auxTypes.push({ name: t.name, body: qualifyComponentRefsIR(t.body) });
                    }
                  }
                  if (ir.kind === "record" || (ir.kind === "withDoc" && ir.inner.kind === "record")) {
                    if (is2xx) {
                      if (!successAuxTypes.some((x) => x.name === base)) successAuxTypes.push({ name: base, body: ir });
                    } else if (!isDefault) {
                      if (!auxTypes.some((x) => x.name === base)) auxTypes.push({ name: base, body: ir });
                    }
                    payload = base;
                  } else {
                    payload = printTypeIR(ir);
                  }
                }
              } else {
                payload = "unknown";
                unknownReason = "no schema for chosen media type";
              }
            } else {
              payload = "unit";
              noContent = true;
            }

            if (is2xx) bodies.push({ code: status, ty: payload ?? "unknown" });

            // Per-status headers (skip for default; it will never match)
            const headersVal = resolved && typeof resolved === "object" ? resolved.headers : undefined;
            let headerTypeName: string | undefined = undefined;
            if (!isDefault) {
              headerTypeName = toValidTypeName(`status_${status}_headers`);
              if (!headerTypeDefs.some((t) => t.name === headerTypeName)) {
                if (headersVal && typeof headersVal === "object" && Object.keys(headersVal).length > 0) {
                  const fieldsIR: FieldIR[] = [];
                  for (const [hname, hlike] of Object.entries(headersVal)) {
                    const header: HeaderObject | undefined = isRef(hlike)
                      ? ctx.resolve<HeaderObject>(hlike.$ref)
                      : hlike;
                    let actualIR: TypeIR = refIR("string");
                    if (header && typeof header === "object") {
                      if (header.schema) {
                        actualIR = mapSchemaToIR(header.schema, ctx, {});
                      } else if (header.content && typeof header.content === "object") {
                        const ents = Object.entries(header.content);
                        const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                        const chosen = chosenEntry?.[1];
                        const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
                        if (chosenResolved && chosenResolved.schema) actualIR = qualifyComponentRefsIR(mapSchemaToIR(chosenResolved.schema, ctx, { collectAuxDecl: (node) => { modItems.push(node); } }));
                        else actualIR = rawIR("unknown");
                      }
                    }
                    const fn = toValidResFieldName(hname);
                    const field: FieldIR = {
                      name: fn.rendered,
                      attr: fn.attr ?? undefined,
                      typ: refIR("string"),
                      optional: "option",
                    };
                    const printedActual = printTypeIR(actualIR);
                    if (printedActual !== "string") {
                      const doc = wrapBlockDoc(`actual: ${printedActual}`);
                      if (doc) field.doc = doc;
                    }
                    fieldsIR.push(field);
                  }
                  headerTypeDefs.push({ name: headerTypeName, body: recordIR(fieldsIR) });
                } else {
                  headerTypeDefs.push({ name: headerTypeName, body: rawIR("emptyObject") });
                }
              }
            }

            // Build variants
            const ctorBase = refNameForCtor ?? "Data";
            const asAttr = !isNaN(n) ? `@as(${status}) ` : undefined;
            if (is2xx) {
              const ctor = `${ctorBase}S${status}`;
              let c = ctor;
              let i = 2;
              while (usedSuccessCtors.has(c)) c = `${ctor}_${i++}`;
              usedSuccessCtors.add(c);
              let pl = payload ?? "unknown";
              if (pl === "unknown") {
                const auxName = toValidTypeName(`status_${status}_body`);
                const doc = wrapBlockDoc(`TODO: ${unknownReason ?? "unknown response body"}`);
                if (!successAuxTypes.some((x) => x.name === auxName)) successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unknown")) });
                pl = auxName;
              } else if (pl === "unit" && noContent) {
                const auxName = toValidTypeName(`status_${status}_body`);
                const doc = wrapBlockDoc("response has no content");
                if (!successAuxTypes.some((x) => x.name === auxName)) successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unit")) });
                pl = auxName;
              }
              const resultTypeName = toValidTypeName(`status_${status}_result`);
              if (!variantAuxTypes.some((t) => t.name === resultTypeName)) {
                const rec = recordIR([
                  { name: "data", typ: rawIR(pl) },
                  { name: "response", typ: refIR("Response.t") },
                  { name: "headers", typ: refIR(headerTypeName) },
                ]);
                variantAuxTypes.push({ name: resultTypeName, body: rec });
              }
              const resultRef = refIR(resultTypeName);
              successVariants.push({ label: c, payload: resultRef, attr: asAttr });
              successPayloadTypes.push(pl);
              successStatusCodes.push(status);
            } else {
              if (!isDefault) {
                let c = ctorBase;
                if (usedErrorCtors.has(c)) {
                  c = `${ctorBase}S${status}`;
                  let j = 2;
                  while (usedErrorCtors.has(c)) c = `${c}_${j++}`;
                }
                usedErrorCtors.add(c);
                let pl = payload ?? "unknown";
                if (pl === "unit" && noContent) {
                  const auxName = toValidTypeName(`status_${status}_error`);
                  const doc = wrapBlockDoc("response has no content");
                  addAuxType(auxName, `${doc ? doc + "\n" : ""}unit`);
                  pl = auxName;
                }
                // Inline the error result record directly in the ADT payload (no aux type)
                const inlineRec = recordIR([
                  { name: "error", typ: rawIR(pl) },
                  { name: "response", typ: refIR("Response.t") },
                  { name: "headers", typ: refIR(headerTypeName!) },
                ]);
                errorVariants.push({ label: c, payload: inlineRec, attr: asAttr });
              }
            }
          }

          // Emit per-status header types
          if (headerTypeDefs.length > 0) {
            for (const t of headerTypeDefs) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
          }
          // Emit success aux types then error aux types (match previous order)
          if (successAuxTypes.length > 0) {
            for (const t of successAuxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
          }
          if (auxTypes.length > 0) {
            for (const t of auxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
          }
          // status alias after aux types
          if (successStatusCodes.length > 0) {
            const uniq = Array.from(new Set(successStatusCodes));
            const sorted = uniq.sort((a, b) => Number(a) - Number(b));
            const pv = sorted.map((s) => `#${s}`).join(" | ");
            modItems.push({ kind: "type", keyword: "type", name: "status", body: rawIR(`[${pv}]`) });
          }
          // emit variant payload aux types
          if (variantAuxTypes.length > 0) {
            for (const t of variantAuxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
          }
          // success type: flatten to a record when exactly one 2xx variant exists; otherwise emit ADT
          const uniqSuccess = Array.from(new Set(successStatusCodes));
          const isSingle2xx = successVariants.length === 1 && uniqSuccess.length === 1;
          if (isSingle2xx) {
            const s = uniqSuccess[0]!;
            const headerTypeName = toValidTypeName(`status_${s}_headers`);
            const payloadTy = successPayloadTypes[0] ?? "unknown";
            const flattened = recordIR([
              { name: "data", typ: rawIR(payloadTy) },
              { name: "response", typ: refIR("Response.t") },
              { name: "headers", typ: refIR(headerTypeName) },
              { name: "status", typ: rawIR(`[#${s}]`) },
            ]);
            modItems.push({ kind: "type", keyword: "type", name: "success", body: flattened });
          } else if (successVariants.length >= 1) {
            modItems.push({ kind: "attr", code: '@tag("status")' });
            const cases = successVariants.map((v) => ({ label: v.label, payload: v.payload, attr: v.attr }));
            modItems.push({ kind: "type", keyword: "type", name: "success", body: adtIR(cases) });
          } else {
            modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR("unknown") });
          }
          // error ADT via IR (always ADT)
          if (errorVariants.length > 0) {
            modItems.push({ kind: "attr", code: '@tag("status")' });
            modItems.push({ kind: "attr", code: `@editor.completeFrom(Operations.${mod})` });
            const cases = errorVariants.map((v) => ({ label: v.label, payload: v.payload, attr: v.attr }));
            modItems.push({ kind: "type", keyword: "type", name: "error", body: adtIR(cases) });
          } else {
            modItems.push({ kind: "type", keyword: "type", name: "error", body: rawIR("unknown") });
          }
        } else {
          // No responses declared: fall back to JSON.t success/error to keep API surface consistent
          modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR("JSON.t") });
          modItems.push({ kind: "type", keyword: "type", name: "error", body: rawIR("JSON.t") });
        }

        // Restore aux naming scope and emit module
        CURRENT_AUX_SCOPE = __prevScope;
        // Final IR-qualification pass for all type nodes in this operation module
        for (const n of modItems) {
          if (n.kind === "type") {
            n.body = qualifyComponentRefsIR(n.body);
          }
        }
        if (__hasDefault) {
          // Emit an identity helper to cast the error ADT to JSON.t with an explanatory doc
          const doc = wrapBlockDoc(
            [
              'Note: this operation declares a "default" error response.',
              'Default-style error classification is not currently modeled precisely.',
              'Use the helper below to treat the full error variant as JSON (temporary escape hatch).',
              'This will be improved in a future version.'
            ].join("\n")
          );
          if (doc) modItems.push({ kind: "raw", code: doc });
          modItems.push({ kind: "raw", code: "let errorToJSON: error => JSON.t = v => Obj.magic(v)" });
        }
        opsItems.push({ kind: "module", name: mod, items: modItems });
      }
    }
  };

  emitForContainer(paths, true);
  // When filtering by paths, skip top-level webhooks since they aren't tied to a path
  emitForContainer(webhooks, !!(ctx.includePaths && ctx.includePaths.size > 0) || !!(ctx.includePathPrefixes && ctx.includePathPrefixes.size > 0));

  // Callback operation modules under Operations
  const emitCallbacks = (
    container?: Record<string, PathItemObject | ReferenceObject> | undefined
  ) => {
    if (!container) return;
    for (const [p, item] of Object.entries(container)) {
      if (ctx.includePaths && !ctx.includePaths.has(p)) continue;
      if (!item || typeof item !== "object") continue;
      for (const m of METHODS) {
        const op = "$ref" in item ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const baseName =
          op.operationId && typeof op.operationId === "string" && op.operationId.length > 0
            ? op.operationId
            : `${String(p)}_${String(m)}`;
        const callbacks = op.callbacks;
        if (!callbacks) continue;
        for (const [cbName, cbVal] of Object.entries(callbacks)) {
          const cbResolved = cbVal && isRef(cbVal) ? ctx.resolve<CallbackObject>(cbVal.$ref) : cbVal;
          if (!cbResolved) continue;
          for (const [, cbPathItemLike] of Object.entries(cbResolved)) {
            const cbItem = cbPathItemLike && isRef(cbPathItemLike) ? ctx.resolve<PathItemObject>(cbPathItemLike.$ref) : cbPathItemLike;
            if (!cbItem || typeof cbItem !== "object") continue;
            for (const m2 of METHODS) {
              const cbOp = resolveOperation(cbItem[m2], ctx);
              if (!cbOp) continue;
              const mod = toValidModuleName(`${baseName}_${cbName}_${m2}`);
              const modItems: RSNode[] = [];

              // PARAMETERS
              const allParams: Array<unknown> = [];
              const pathParams = cbItem.parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
              if (Array.isArray(pathParams)) allParams.push(...pathParams);
              const opParams = cbOp.parameters as (import("../types.js").ParameterObject | ReferenceObject)[] | undefined;
              if (Array.isArray(opParams)) allParams.push(...opParams);

              type GroupKey = "query" | "header" | "path" | "cookie";
              const groups: Record<GroupKey, FieldIR[]> = { query: [], header: [], path: [], cookie: [] };
              const paramAux: Array<TypeDeclIR> = [];
              const present: Set<GroupKey> = new Set();
              for (const p2 of allParams) {
                const paramLike = p2 as import("../types.js").ParameterObject | ReferenceObject;
                const param = isRef(paramLike) ? ctx.resolve<import("../types.js").ParameterObject>(paramLike.$ref) : paramLike;
                if (!param || typeof param !== "object") continue;
                const where = param.in;
                const name = param.name;
                if (!where || !name) continue;
                const required = !!param.required;
                const schema = param.schema;
                let pIR: TypeIR = refIR("unknown");
                if (schema) {
                  const base = toValidTypeName(`${mod}_${where}_${toValidTypeName(name)}`);
                  let ir = mapSchemaToIR(schema, ctx, {
                    parentName: base,
                    collectAux: (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                  });
                  ir = hoistFieldTypeIfNeeded(ir, (n, b) => {
                    const { doc, code } = splitDocBlock(b);
                    paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
                  }, base, toValidTypeName(name));
                  pIR = ir;
                }
                const fname = toValidResFieldName(name);
          const field: FieldIR = {
            name: fname.rendered,
            attr: fname.attr ?? undefined,
            typ: pIR,
            // Input context (callback params): use questionMark optional
            optional: required ? undefined : "questionMark",
          };
                {
                  const fb = docForJSONFallback(field.typ);
                  if (fb) field.doc = wrapBlockDoc(fb);
                }
                groups[where].push(field);
                present.add(where);
              }

              const fieldOrder: GroupKey[] = ["query", "header", "path", "cookie"];
              if (paramAux.length > 0) {
                for (const t of paramAux) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
              }
              for (const k of fieldOrder) {
                if (!present.has(k)) continue;
                const body = groups[k];
                modItems.push({ kind: "type", keyword: "type", name: k, body: recordIR(body) });
              }
              if (present.size > 0) {
                const paramsFields: FieldIR[] = [];
                for (const k of fieldOrder) {
                  if (!present.has(k)) continue;
                  const target = toValidResFieldName(k);
                  paramsFields.push({
                    name: target.rendered,
                    attr: target.attr ?? undefined,
                    typ: refIR(k),
                    // Input context: questionMark optional for group fields
                    optional: "questionMark",
                  });
                }
                const paramsBody = recordIR(paramsFields);
                modItems.push({ kind: "type", keyword: "type", name: "params", body: paramsBody });
              }

              // REQUEST BODY
              let bodyType: string | undefined = undefined;
              const rb = cbOp.requestBody;
              if (rb) {
                const req = isRef(rb) ? ctx.resolve<RequestBodyObject>(rb.$ref) : rb;
                const content = req && req.content && typeof req.content === "object" ? req.content : undefined;
                if (content) {
                  const entries = Object.entries(content);
                  let chosen: MediaTypeObject | ReferenceObject | undefined = undefined;
                  for (const [k, v] of entries) {
                    if (k === "application/json") {
                      chosen = v;
                      break;
                    }
                  }
              if (!chosen && entries.length === 1) chosen = entries[0]![1];
              const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
              if (chosenResolved && chosenResolved.schema) {
                // Detect simple untagged union for callback request body and emit ADT + alias + codec
                const union = ((): SimpleUnionDetection | undefined => {
                  const sch = isRef(chosenResolved!.schema) ? ctx.resolve<SchemaObject>((chosenResolved!.schema as any).$ref) : (chosenResolved!.schema as any);
                  if (!sch) return undefined;
                  const members = (sch as any).oneOf ?? (sch as any).anyOf;
                  if (Array.isArray(members) && members.length > 0) return detectSimpleUntaggedUnion(members as SchemaLike[], ctx, (sch as any).discriminator);
                  return undefined;
                })();
                if (union && union.ok) {
                  const adtName = toValidTypeName(`${mod}_request_body_data`);
                  const aliasName = toValidTypeName(`${adtName}_wrapped`);
                  const cases: Array<{ label: string; payload: TypeIR }> = [];
                  const auxLocal: Array<TypeDeclIR> = [];
                  const members = ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).oneOf ?? ((isRef(chosenResolved.schema) ? ctx.resolve<SchemaObject>((chosenResolved.schema as any).$ref) : (chosenResolved.schema as any)) as any).anyOf;
                  for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                    const m = (members as SchemaLike[])[i]!;
                    if (isRef(m)) {
                      const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                      cases.push({ label: union.labels[i]!, payload: qualifyComponentRefsIR(refIR(rn)) });
                    } else {
                      const payloadBase = toValidTypeName(`${adtName}_${union.labels[i]}`);
                    let irMem = mapSchemaToIR(m, ctx, {
                      parentName: payloadBase,
                      collectAux: (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                      optionalAsOption: true,
                      qualifyOpsRefs: true,
                      collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                    });
                        irMem = hoistInlineRecordsIR(
                          irMem,
                          (n, b) => {
                            const { doc, code } = splitDocBlock(b);
                            auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                          },
                          payloadBase,
                          true,
                          undefined,
                          /*qualify*/ true,
                          (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                        );
                      irMem = qualifyComponentRefsIR(irMem);
                      const printed = printTypeIR(irMem);
                      const auxNm = nameWithHash(payloadBase, printed);
                      auxLocal.push({ name: auxNm, body: irMem });
                      cases.push({ label: union.labels[i]!, payload: refIR(auxNm) });
                    }
                  }
                  if (auxLocal.length > 0) {
                    for (const t of auxLocal) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                  }
                  if (union.allowUnknown) cases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
                  modItems.push({ kind: "attr", code: '@tag("kind")' });
                  modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                  const codecModName = toValidModuleName(adtName);
                  const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                  modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                  type Step = { kind: "literal"; prop: string } | { kind: "keys" };
                  const steps: Step[] = [];
                  const seenLitProps = new Set<string>();
                  const litMap = new Map<string, Array<{ value: string; label: string }>>();
                  let sawKeys = false;
                  const keyPairs: Array<{ prop: string; label: string }> = [];
                  for (let i = 0; i < union.signals.length; i++) {
                    const sig = union.signals[i]! as any;
                    const label = union.labels[i]!;
                    if (sig.kind === "literal") {
                      const arr = litMap.get(sig.prop) ?? [];
                      arr.push({ value: String(sig.value), label });
                      litMap.set(sig.prop, arr);
                      if (!seenLitProps.has(sig.prop)) { steps.push({ kind: "literal", prop: sig.prop }); seenLitProps.add(sig.prop); }
                    } else {
                      keyPairs.push({ prop: sig.prop, label });
                      if (!sawKeys) { steps.push({ kind: "keys" }); sawKeys = true; }
                    }
                  }
                  const buildTailOpt = (): string => {
                    let tail = union.allowUnknown ? 'Some(UnionDecode.make("Unknown", json))' : 'None';
                    for (let i = steps.length - 1; i >= 0; i--) {
                      const st = steps[i]!;
                      if (st.kind === "literal") {
                        const arr = litMap.get(st.prop) ?? [];
                        const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapLit = `dict{${parts}}`;
                        const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      } else {
                        const parts = keyPairs.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                        const mapKey = `dict{${parts}}`;
                        const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                        tail = `${head}${tail}}`;
                      }
                    }
                    return tail;
                  };
                  const rsPriv = [
                    "%%private(",
                    `let decode_: ${aliasName} => option<${adtName}> = json => {`,
                    `  ${buildTailOpt()}`,
                    `}`,
                    ")",
                  ].join("\n");
                  const rsThrow = [
                    `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
                    `  switch decode_(json) {`,
                    `  | Some(v) => v`,
                    `  | None => JsError.throwWithMessage("No matching union member")`,
                    `  }`,
                    `}`,
                  ].join("\n");
                  const rsRes = [
                    `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
                    `  switch decode_(json) {`,
                    `  | Some(v) => Ok(v)`,
                    `  | None => Error(#DecodeError("No matching union member"))`,
                    `  }`,
                    `}`,
                  ].join("\n");
                  const decDoc = wrapBlockDoc(
                    [
                      "Decoder for simple untagged union.",
                      "Matching signals:",
                      ...union.signals.map((s, i) => s.kind === "literal" ? `- ${union.labels[i]!}: ${s.prop} == ${s.value}` : `- ${union.labels[i]!}: has key ${s.prop}`),
                      union.allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
                    ].join("\n")
                  );
                  if (decDoc) modItems.push({ kind: "raw", code: decDoc });
                  const rsEncode = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
                  modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [
                    { kind: "raw", code: rsPriv },
                    { kind: "raw", code: rsThrow },
                    { kind: "raw", code: rsRes },
                    { kind: "raw", code: rsEncode },
                  ]});
                  // Additional Encoder_ module to enforce literals on encoding
                  {
                    const encLines: string[] = [];
                    if (union.allowUnknown) encLines.push(`  | Unknown(x) => Obj.magic(x)`);
                    for (let i = 0; i < union.labels.length; i++) {
                      const label = union.labels[i]!;
                      const sig = union.signals[i]! as any;
                      if (sig.kind === "literal") {
                        encLines.push(`  | ${label}(x) => Obj.magic(UnionEncode.ensureLiteral(x, ${JSON.stringify(sig.prop)}, ${JSON.stringify(String(sig.value))}))`);
                      } else {
                        encLines.push(`  | ${label}(x) => Obj.magic(x)`);
                      }
                    }
                    const rsEncode2 = [
                      `let encode: ${adtName} => ${aliasName} = v => {`,
                      `  switch v {`,
                      ...encLines,
                      `  }`,
                      `}`,
                    ].join("\n");
                    modItems.push({ kind: "module", name: `Encoder_${toValidModuleName(adtName)}`, items: [
                      { kind: "raw", code: rsEncode2 },
                    ]});
                  }
                  bodyType = aliasName;
                } else if (union && !union.ok) {
                  // Ambiguous untagged union in callback request body → emit ADT + alias (encode-only)
                  const adtName = toValidTypeName(`${mod}_request_body_data`);
                  const aliasName = toValidTypeName(`${adtName}_wrapped`);
                  const cases: Array<{ label: string; payload: TypeIR }> = [];
                  const auxLocal: Array<TypeDeclIR> = [];
                  const members = ((isRef(chosenResolved!.schema) ? ctx.resolve<SchemaObject>((chosenResolved!.schema as any).$ref) : (chosenResolved!.schema as any)) as any).oneOf ?? ((isRef(chosenResolved!.schema) ? ctx.resolve<SchemaObject>((chosenResolved!.schema as any).$ref) : (chosenResolved!.schema as any)) as any).anyOf;
                  for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                    const m = (members as SchemaLike[])[i]!;
                    if (isRef(m)) {
                      const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                      const lbl = toValidModuleName(rn ?? `Member${i + 1}`);
                      cases.push({ label: lbl, payload: qualifyComponentRefsIR(refIR(rn)) });
                    } else {
                      const payloadBase = toValidTypeName(`${adtName}_member_${i + 1}`);
                      let irMem = mapSchemaToIR(m, ctx, {
                        parentName: payloadBase,
                        collectAux: (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        optionalAsOption: true,
                        qualifyOpsRefs: true,
                        collectAuxIR: (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                      });
                      irMem = hoistInlineRecordsIR(
                        irMem,
                        (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        payloadBase,
                        true,
                        undefined,
                        /*qualify*/ true,
                        (n2, bodyIR) => { auxLocal.push({ name: n2, body: bodyIR }); },
                      );
                      irMem = qualifyComponentRefsIR(irMem);
                      const printed = printTypeIR(irMem);
                      const auxNm = nameWithHash(payloadBase, printed);
                      auxLocal.push({ name: auxNm, body: irMem });
                      const lbl = toValidModuleName(`Member${i + 1}`);
                      cases.push({ label: lbl, payload: refIR(auxNm) });
                    }
                  }
                  if (auxLocal.length > 0) {
                    const seenAux = new Set<string>();
                    for (const t of auxLocal) {
                      if (seenAux.has(t.name)) continue;
                      modItems.push({ kind: "type", keyword: "type", name: t.name, body: qualifyComponentRefsIR(t.body) });
                      seenAux.add(t.name);
                    }
                  }
                  const ambDoc = wrapBlockDoc("Ambiguous untagged union: encode-only; no safe decoder (no unique discriminator). ");
                  if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                  modItems.push({ kind: "attr", code: '@tag("kind")' });
                  modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                  const codecModName = toValidModuleName(adtName);
                  if (ambDoc) modItems.push({ kind: "raw", code: ambDoc });
                  const fullDecoderPath = `Operations.${mod}.${codecModName}`;
                  modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath})\n type ${aliasName}` });
                const rsCodec = [
                  `let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`,
                  `let decodeOrThrow: ${aliasName} => JSON.t = v => Obj.magic(v)`,
                  `let decode: ${aliasName} => result<JSON.t, [> #DecodeError(string)]> = v => Ok(Obj.magic(v))`,
                ].join("\n");
                modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsCodec } ] });
                bodyType = aliasName;
                } else {
                  const auxReq: Array<TypeDeclIR> = [];
                  const base = toValidTypeName(`${mod}_request_body`);
                  let ir = mapSchemaToIR(chosenResolved.schema, ctx, {
                    parentName: base,
                    collectAux: (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      auxReq.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                    qualifyOpsRefs: true,
                  });
                  ir = hoistInlineRecordsIR(
                    ir,
                    (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      auxReq.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                    base,
                    true,
                    undefined,
                    /*qualify*/ true,
                  );
                  ir = qualifyComponentRefsIR(ir);
                  if (auxReq.length > 0) {
                    for (const t of auxReq) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                  }
                  if (ir.kind === "record" || (ir.kind === "withDoc" && ir.inner.kind === "record")) {
                    modItems.push({ kind: "type", keyword: "type", name: base, body: ir });
                    bodyType = base;
                  } else {
                    bodyType = printTypeIR(ir);
                  }
                }
              } else {
                bodyType = "JSON.t";
              }
                }
              }

              // PARAMETERS wrapper
              const parametersFields: FieldIR[] = [];
              if (present.size > 0)
                parametersFields.push({ name: "params", typ: refIR("params"), optional: "questionMark" });
              if (bodyType)
                parametersFields.push({ name: "body", typ: rawIR(bodyType), optional: "questionMark" });
              // Per-call overrides: headers and baseUrl (input context → questionMark)
              parametersFields.push({ name: "headers", typ: appIR(refIR("dict"), [refIR("string")]), optional: "questionMark" });
              parametersFields.push({ name: "baseUrl", typ: refIR("string"), optional: "questionMark" });
              if (parametersFields.length > 0) {
                const pBody = recordIR(parametersFields);
                modItems.push({ kind: "type", keyword: "type", name: "parameters", body: pBody });
              } else {
                modItems.push({ kind: "type", keyword: "type", name: "parameters", body: rawIR("emptyObject") });
              }

              // RESPONSES (callbacks)
              const responses = cbOp.responses;
              const successVariants: Array<{ label: string; payload: TypeIR; attr?: string }> = [];
              const successPayloadTypes: string[] = [];
              const successStatusCodes: string[] = [];
              const errorVariants: Array<{ label: string; payload: TypeIR; attr?: string }> = [];
              const auxTypes: Array<TypeDeclIR> = [];
              const successAuxTypes: Array<TypeDeclIR> = [];
              const variantAuxTypes: Array<TypeDeclIR> = [];
              const usedSuccessCtors: Set<string> = new Set();
              const usedErrorCtors: Set<string> = new Set();
              const headerTypeDefs: Array<TypeDeclIR> = [];
              if (responses && typeof responses === "object") {
                const entries = Object.entries(responses);
                const bodies: Array<{ code: string; ty: string }> = [];
                for (const [status, respLike] of entries) {
                  const resp = isRef(respLike) ? ctx.resolve<ResponseObject>(respLike.$ref) : respLike;
                  if (!resp || typeof resp !== "object") continue;
                  const isDefault = status === "default";
                  const n = Number(status);
                  const is2xx = !isNaN(n) && n >= 200 && n < 300;
                  const refNameForCtor = isRef(respLike) ? refName(respLike.$ref) : undefined;
                  let payload: string | undefined;
                  let unknownReason: string | undefined;
                  let noContent: boolean = false;
                  if (resp.content && typeof resp.content === "object") {
                    const ents = Object.entries(resp.content);
                    const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                    const chosen = chosenEntry?.[1];
                    if (chosen && chosen.schema) {
                      const base = toValidTypeName(`status_${status}_body`);
                const union = ((): SimpleUnionDetection | undefined => {
                        const sch = isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any);
                        if (!sch) return undefined;
                        const members = (sch as any).oneOf ?? (sch as any).anyOf;
                        if (Array.isArray(members) && members.length > 0) return detectSimpleUntaggedUnion(members as SchemaLike[], ctx, (sch as any).discriminator);
                        return undefined;
                      })();
                      if (union && union.ok) {
                        if (isDefault) {
                          // Skip emitting types for default; not represented in error ADT
                          payload = "unknown";
                        } else {
                        const adtName = toValidTypeName(`status_${status}_result_data`);
                        const aliasName = toValidTypeName(`${adtName}_wrapped`);
                        const cases: Array<{ label: string; payload: TypeIR }> = [];
                        const auxLocal: Array<TypeDeclIR> = [];
                        const members = ((isRef(chosen.schema) ? ctx.resolve<SchemaObject>((chosen.schema as any).$ref) : (chosen.schema as any)) as any).oneOf ?? ((isRef(chosen.schema) ? ctx.resolve<SchemaObject>((chosen.schema as any).$ref) : (chosen.schema as any)) as any).anyOf;
                        for (let i = 0; i < (members as SchemaLike[]).length; i++) {
                          const m = (members as SchemaLike[])[i]!;
                          if (isRef(m)) {
                            const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                            cases.push({ label: union.labels[i]!, payload: qualifyComponentRefsIR(refIR(rn)) });
                          } else {
                            const payloadBase = toValidTypeName(`${adtName}_${union.labels[i]}`);
                            let irMem = mapSchemaToIR(m, ctx, {
                              parentName: payloadBase,
                              collectAux: (n, b) => {
                                const { doc, code } = splitDocBlock(b);
                                auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                              },
                              optionalAsOption: true,
                            });
                            irMem = hoistInlineRecordsIR(
                              irMem,
                              (n, b) => {
                                const { doc, code } = splitDocBlock(b);
                                auxLocal.push({ name: n, body: withDoc(doc, rawIR(code)) });
                              },
                              payloadBase,
                              true,
                              undefined,
                              /*qualify*/ true,
                            );
                            irMem = qualifyComponentRefsIR(irMem);
                            const printed = printTypeIR(irMem);
                            const auxNm = nameWithHash(payloadBase, printed);
                            auxLocal.push({ name: auxNm, body: irMem });
                            cases.push({ label: union.labels[i]!, payload: refIR(auxNm) });
                          }
                        }
                        if (auxLocal.length > 0) {
                          for (const t of auxLocal) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                        }
                        if (union.allowUnknown) cases.unshift({ label: "Unknown", payload: refIR("JSON.t") });
                        modItems.push({ kind: "attr", code: '@tag("kind")' });
                        modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(cases) });
                        // Alias wrapped with editor completion hint
                        const codecModName2_forAlias = toValidModuleName(adtName);
                        const fullDecoderPath2_forAlias = `Operations.${mod}.${codecModName2_forAlias}`;
                        modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath2_forAlias})\n type ${aliasName}` });
                        // Group signals (callbacks) same as above
                        type Step2 = { kind: "literal"; prop: string } | { kind: "keys" };
                        const steps2: Step2[] = [];
                        const seenLit2 = new Set<string>();
                        const litMap2 = new Map<string, Array<{ value: string; label: string }>>();
                        let sawKeys2 = false;
                        const keyPairs2: Array<{ prop: string; label: string }> = [];
                        for (let i = 0; i < union.signals.length; i++) {
                          const sig = union.signals[i]! as any;
                          const label = union.labels[i]!;
                          if (sig.kind === "literal") {
                            const arr = litMap2.get(sig.prop) ?? [];
                            arr.push({ value: String(sig.value), label });
                            litMap2.set(sig.prop, arr);
                            if (!seenLit2.has(sig.prop)) { steps2.push({ kind: "literal", prop: sig.prop }); seenLit2.add(sig.prop); }
                          } else {
                            keyPairs2.push({ prop: sig.prop, label });
                            if (!sawKeys2) { steps2.push({ kind: "keys" }); sawKeys2 = true; }
                          }
                        }
                        const buildTail2 = (kind: "throw" | "result"): string => {
                          let tail2 = kind === "throw"
                            ? (union.allowUnknown ? 'UnionDecode.make("Unknown", json)' : 'JsError.throwWithMessage("No matching union member")')
                            : (union.allowUnknown ? 'Ok(UnionDecode.make("Unknown", json))' : 'Error(#DecodeError("No matching union member"))');
                          for (let i = steps2.length - 1; i >= 0; i--) {
                            const st = steps2[i]!;
                            if (st.kind === "literal") {
                              const arr = litMap2.get(st.prop) ?? [];
                              const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                              const mapLit = `dict{${parts}}`;
                              const head = kind === "throw"
                                ? `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => UnionDecode.make(l, json) | None => `
                                : `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Ok(UnionDecode.make(l, json)) | None => `;
                              tail2 = `${head}${tail2}}`;
                            } else {
                              const parts = keyPairs2.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                              const mapKey = `dict{${parts}}`;
                              const head = kind === "throw"
                                ? `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => UnionDecode.make(l, json) | None => `
                                : `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Ok(UnionDecode.make(l, json)) | None => `;
                              tail2 = `${head}${tail2}}`;
                            }
                          }
                          return tail2;
                        };
                        const buildTailOpt2 = (): string => {
                          let tail2 = union.allowUnknown
                            ? 'Some(UnionDecode.make("Unknown", json))'
                            : 'None';
                          for (let i = steps2.length - 1; i >= 0; i--) {
                            const st = steps2[i]!;
                            if (st.kind === "literal") {
                              const arr = litMap2.get(st.prop) ?? [];
                              const parts = arr.map((p) => `${JSON.stringify(p.value)}: ${JSON.stringify(p.label)}`).join(", ");
                              const mapLit = `dict{${parts}}`;
                              const head = `switch UnionDecode.chooseByLiteral(json, ${JSON.stringify(st.prop)}, ${mapLit}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                              tail2 = `${head}${tail2}}`;
                            } else {
                              const parts = keyPairs2.map((p) => `${JSON.stringify(p.prop)}: ${JSON.stringify(p.label)}`).join(", ");
                              const mapKey = `dict{${parts}}`;
                              const head = `switch UnionDecode.chooseByKeys(json, ${mapKey}) { | Some(l) => Some(UnionDecode.make(l, json)) | None => `;
                              tail2 = `${head}${tail2}}`;
                            }
                          }
                          return tail2;
                        };
                        const codecModName2 = toValidModuleName(adtName);
                        const fullDecoderPath2 = `Operations.${mod}.${codecModName2}`;
                        const rsPriv2 = [
                          "%%private(",
                          `let decode_: ${aliasName} => option<${adtName}> = json => {`,
                          `  ${buildTailOpt2()}`,
                          `}`,
                          ")",
                        ].join("\n");
                        const rsThrow2 = [
                          `let decodeOrThrow: ${aliasName} => ${adtName} = json => {`,
                          `  switch decode_(json) {`,
                          `  | Some(v) => v`,
                          `  | None => JsError.throwWithMessage("No matching union member")`,
                          `  }`,
                          `}`,
                        ].join("\n");
                        const rsRes2 = [
                          `let decode: ${aliasName} => result<${adtName}, [> #DecodeError(string)]> = json => {`,
                          `  switch decode_(json) {`,
                          `  | Some(v) => Ok(v)`,
                          `  | None => Error(#DecodeError("No matching union member"))`,
                          `  }`,
                          `}`,
                        ].join("\n");
                        const decDoc = wrapBlockDoc(
                          [
                            "Decoder for simple untagged union.",
                            "Matching signals:",
                            ...union.signals.map((s, i) => s.kind === "literal" ? `- ${union.labels[i]!}: ${s.prop} == ${s.value}` : `- ${union.labels[i]!}: has key ${s.prop}`),
                            union.allowUnknown ? "Includes Unknown(JSON.t) fallback on no-match." : "No fallback; throws on no-match.",
                          ].join("\n")
                        );
                        if (decDoc) modItems.push({ kind: "raw", code: decDoc });
                        const rsEncode2 = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
                        modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [
                          { kind: "raw", code: rsPriv2 },
                          { kind: "raw", code: rsThrow2 },
                          { kind: "raw", code: rsRes2 },
                          { kind: "raw", code: rsEncode2 },
                        ]});
                        // Encoder module (callbacks/responses path)
                        {
                          const encLines2: string[] = [];
                          if (union.allowUnknown) encLines2.push(`  | Unknown(x) => Obj.magic(x)`);
                          for (let i = 0; i < union.labels.length; i++) {
                            const label = union.labels[i]!;
                            const sig = union.signals[i]! as any;
                            if (sig.kind === "literal") {
                              encLines2.push(`  | ${label}(x) => Obj.magic(UnionEncode.ensureLiteral(x, ${JSON.stringify(sig.prop)}, ${JSON.stringify(String(sig.value))}))`);
                            } else {
                              encLines2.push(`  | ${label}(x) => Obj.magic(x)`);
                            }
                          }
                          const rsEncode2 = [
                            `let encode: ${adtName} => ${aliasName} = v => {`,
                            `  switch v {`,
                            ...encLines2,
                            `  }`,
                            `}`,
                          ].join("\n");
                          modItems.push({ kind: "module", name: `Encoder_${toValidModuleName(adtName)}`, items: [
                            { kind: "raw", code: rsEncode2 },
                          ]});
                        }
                        payload = aliasName;
                        }
                      } else if (union && !union.ok) {
                        if (isDefault) {
                          // Skip emitting types for default; not represented in error ADT
                          payload = "unknown";
                        } else {
                          // Ambiguous untagged union in callback response → emit ADT + alias (encode-only)
                          const adtName = toValidTypeName(`status_${status}_result_data`);
                          const aliasName = toValidTypeName(`${adtName}_wrapped`);
                          const casesAmb: Array<{ label: string; payload: TypeIR }> = [];
                          const auxLocalAmb: Array<TypeDeclIR> = [];
                          const membersAmb = ((isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any)) as any).oneOf ?? ((isRef(chosen!.schema) ? ctx.resolve<SchemaObject>((chosen!.schema as any).$ref) : (chosen!.schema as any)) as any).anyOf;
                          for (let i = 0; i < (membersAmb as SchemaLike[]).length; i++) {
                            const m = (membersAmb as SchemaLike[])[i]!;
                            if (isRef(m)) {
                              const rn = refName(m.$ref) ?? toValidTypeName(`member_${i + 1}`);
                              const lbl = toValidModuleName(rn ?? `Member${i + 1}`);
                              casesAmb.push({ label: lbl, payload: qualifyComponentRefsIR(refIR(rn)) });
                            } else {
                              const payloadBase = toValidTypeName(`${adtName}_member_${i + 1}`);
                              let irMem = mapSchemaToIR(m, ctx, {
                                parentName: payloadBase,
                                collectAux: (n, b) => {
                                  const { doc, code } = splitDocBlock(b);
                                  auxLocalAmb.push({ name: n, body: withDoc(doc, rawIR(code)) });
                                },
                                optionalAsOption: true,
                                qualifyOpsRefs: true,
                                collectAuxIR: (n2, bodyIR) => { auxLocalAmb.push({ name: n2, body: bodyIR }); },
                              });
                              irMem = hoistInlineRecordsIR(
                                irMem,
                                (n, b) => {
                                  const { doc, code } = splitDocBlock(b);
                                  auxLocalAmb.push({ name: n, body: withDoc(doc, rawIR(code)) });
                                },
                                payloadBase,
                                true,
                                undefined,
                                /*qualify*/ true,
                                (n2, bodyIR) => { auxLocalAmb.push({ name: n2, body: bodyIR }); },
                              );
                              irMem = qualifyComponentRefsIR(irMem);
                              const printed = printTypeIR(irMem);
                              const auxNm = nameWithHash(payloadBase, printed);
                              auxLocalAmb.push({ name: auxNm, body: irMem });
                              const lbl = toValidModuleName(`Member${i + 1}`);
                              casesAmb.push({ label: lbl, payload: refIR(auxNm) });
                            }
                          }
                          if (auxLocalAmb.length > 0) {
                            for (const t of auxLocalAmb) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                          }
                          const ambDoc2 = wrapBlockDoc("Ambiguous untagged union: encode-only; no safe decoder (no unique discriminator). ");
                          if (ambDoc2) modItems.push({ kind: "raw", code: ambDoc2 });
                          modItems.push({ kind: "attr", code: '@tag("kind")' });
                          modItems.push({ kind: "type", keyword: "type", name: adtName, body: adtIR(casesAmb) });
                          const codecModName2_forAlias2 = toValidModuleName(adtName);
                          if (ambDoc2) modItems.push({ kind: "raw", code: ambDoc2 });
                          const fullDecoderPath2_forAlias2 = `Operations.${mod}.${codecModName2_forAlias2}`;
                          modItems.push({ kind: "raw", code: `@editor.completeFrom(${fullDecoderPath2_forAlias2})\n type ${aliasName}` });
                          const rsEncodeOnly2 = [`let encode: ${adtName} => ${aliasName} = v => UnionCodec.encode(v)`].join("\n");
                          modItems.push({ kind: "module", name: toValidModuleName(adtName), items: [ { kind: "raw", code: rsEncodeOnly2 } ] });
                          payload = aliasName;
                        }
                      } else {
                        if (isDefault) {
                          // Skip emitting types for default; not represented in error ADT
                          payload = "unknown";
                        } else {
                        const auxReq: Array<TypeDeclIR> = [];
                        let ir = mapSchemaToIR(chosen.schema, ctx, {
                          parentName: base,
                          collectAux: (n, b) => {
                            const { doc, code } = splitDocBlock(b);
                            auxReq.push({ name: n, body: withDoc(doc, rawIR(code)) });
                          },
                          optionalAsOption: true,
                        });
                        ir = hoistInlineRecordsIR(
                          ir,
                          (n, b) => {
                            const { doc, code } = splitDocBlock(b);
                            auxReq.push({ name: n, body: withDoc(doc, rawIR(code)) });
                          },
                          base,
                          true,
                          undefined,
                          /*qualify*/ true,
                        );
                        ir = qualifyComponentRefsIR(ir);
                  if (auxReq.length > 0) {
                          if (is2xx) {
                            for (const t of auxReq) if (!successAuxTypes.some((x) => x.name === t.name)) successAuxTypes.push({ name: t.name, body: qualifyComponentRefsIR(t.body) });
                          } else if (!isDefault) {
                            for (const t of auxReq) if (!auxTypes.some((x) => x.name === t.name)) auxTypes.push({ name: t.name, body: qualifyComponentRefsIR(t.body) });
                          }
                        }
                        if (ir.kind === "record" || (ir.kind === "withDoc" && ir.inner.kind === "record")) {
                          if (is2xx) {
                            if (!successAuxTypes.some((x) => x.name === base)) successAuxTypes.push({ name: base, body: ir });
                          } else if (!isDefault) {
                            if (!auxTypes.some((x) => x.name === base)) auxTypes.push({ name: base, body: ir });
                          }
                          payload = base;
                        } else {
                          payload = printTypeIR(ir);
                        }
                        }
                      }
                    } else {
                      payload = "unknown";
                      unknownReason = "no schema for chosen media type";
                    }
                  } else {
                    payload = "unit";
                    noContent = true;
                  }
                  if (is2xx && payload) bodies.push({ code: status, ty: payload });
                  const headersVal = resp.headers;
                  let headerTypeName: string | undefined = undefined;
                  if (!isDefault) headerTypeName = toValidTypeName(`status_${status}_headers`);
                  if (headerTypeName && !headerTypeDefs.some((t) => t.name === headerTypeName)) {
                    if (headersVal && typeof headersVal === "object" && Object.keys(headersVal).length > 0) {
                      const fields: FieldIR[] = [];
                      for (const [hname, hlike] of Object.entries(headersVal)) {
                        const header: HeaderObject | undefined = isRef(hlike) ? ctx.resolve<HeaderObject>(hlike.$ref) : hlike;
                        let actualIR: TypeIR = refIR("string");
                        if (header && typeof header === "object") {
                          if (header.schema) actualIR = qualifyComponentRefsIR(mapSchemaToIR(header.schema, ctx, {}));
                          else if (header.content && typeof header.content === "object") {
                            const ents = Object.entries(header.content);
                            const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                            const chosen = chosenEntry?.[1];
                            const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
                            if (chosenResolved && chosenResolved.schema) actualIR = mapSchemaToIR(chosenResolved.schema, ctx, {});
                            else actualIR = rawIR("unknown");
                          }
                        }
                        const fn = toValidResFieldName(hname);
                        const field: FieldIR = {
                          name: fn.rendered,
                          attr: fn.attr ?? undefined,
                          typ: refIR("string"),
                          optional: "option",
                        };
                        const printedActual = printTypeIR(actualIR);
                        if (printedActual !== "string") {
                          const doc = wrapBlockDoc(`actual: ${printedActual}`);
                          if (doc) field.doc = doc;
                        }
                        fields.push(field);
                      }
                      headerTypeDefs.push({ name: headerTypeName, body: recordIR(fields) });
                    } else {
                      headerTypeDefs.push({ name: headerTypeName, body: rawIR(`emptyObject`) });
                    }
                  }

                  const ctorBase = refNameForCtor ?? "Data";
                  const asAttr = !isNaN(n) ? `@as(${status}) ` : undefined;
                  if (is2xx) {
                    const ctor = `${ctorBase}S${status}`;
                    let c = ctor;
                    let i = 2;
                    while (usedSuccessCtors.has(c)) c = `${ctor}_${i++}`;
                    usedSuccessCtors.add(c);
                    let pl = payload ?? "unknown";
                    if (pl === "unknown") {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      const doc = wrapBlockDoc(`TODO: ${unknownReason ?? "unknown response body"}`);
                      if (!successAuxTypes.some((x) => x.name === auxName)) successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unknown")) });
                      pl = auxName;
                    } else if (pl === "unit" && noContent) {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      const doc = wrapBlockDoc("response has no content");
                      if (!successAuxTypes.some((x) => x.name === auxName)) successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unit")) });
                      pl = auxName;
                    }
                    const resultTypeName = toValidTypeName(`status_${status}_result`);
                    if (!variantAuxTypes.some((t) => t.name === resultTypeName)) {
                      const rec = recordIR([
                        { name: "data", typ: rawIR(pl) },
                        { name: "response", typ: refIR("Response.t") },
                        { name: "headers", typ: refIR(headerTypeName) },
                      ]);
                      variantAuxTypes.push({ name: resultTypeName, body: rec });
                    }
                    const pay = refIR(resultTypeName);
                    successVariants.push({ label: c, payload: pay, attr: asAttr });
                    successPayloadTypes.push(pl);
                    successStatusCodes.push(status);
                  } else {
                    if (!isDefault) {
                      let c = ctorBase;
                      if (usedErrorCtors.has(c)) {
                        c = `${ctorBase}S${status}`;
                        let j = 2;
                        while (usedErrorCtors.has(c)) c = `${c}_${j++}`;
                      }
                      usedErrorCtors.add(c);
                      let pl = payload ?? "unknown";
                      // Inline the error result record directly in the ADT payload (no aux type)
                      const pay = recordIR([
                        { name: "error", typ: rawIR(pl) },
                        { name: "response", typ: refIR("Response.t") },
                        { name: "headers", typ: refIR(headerTypeName!) },
                      ]);
                      errorVariants.push({ label: c, payload: pay, attr: asAttr });
                    }
                  }
                }

                if (headerTypeDefs.length > 0) {
                  for (const t of headerTypeDefs) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                }
                if (successAuxTypes.length > 0) {
                  for (const t of successAuxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                }
                if (auxTypes.length > 0) {
                  for (const t of auxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                }
                if (successStatusCodes.length > 0) {
                  const uniq = Array.from(new Set(successStatusCodes));
                  const sorted = uniq.sort((a, b) => Number(a) - Number(b));
                  const cases = sorted.map((s) => ({ label: `#${s}` }));
                  modItems.push({ kind: "type", keyword: "type", name: "status", body: polyIR(cases) });
                }
                if (variantAuxTypes.length > 0) {
                  for (const t of variantAuxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                }
                const uniqSuccess2 = Array.from(new Set(successStatusCodes));
                const isSingle2xx_2 = successVariants.length === 1 && uniqSuccess2.length === 1;
                if (isSingle2xx_2) {
                  const s = uniqSuccess2[0]!;
                  const headerTypeName = toValidTypeName(`status_${s}_headers`);
                  const payloadTy = successPayloadTypes[0] ?? "unknown";
                  const flattened = recordIR([
                    { name: "data", typ: rawIR(payloadTy) },
                    { name: "response", typ: refIR("Response.t") },
                    { name: "headers", typ: refIR(headerTypeName) },
                    { name: "status", typ: rawIR(`[#${s}]`) },
                  ]);
                  modItems.push({ kind: "type", keyword: "type", name: "success", body: flattened });
                } else if (successVariants.length >= 1) {
                  modItems.push({ kind: "attr", code: '@tag("status")' });
                  const cases2 = successVariants.map((v) => ({ label: v.label, payload: v.payload, attr: v.attr }));
                  modItems.push({ kind: "type", keyword: "type", name: "success", body: adtIR(cases2) });
                } else {
                  modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR("unknown") });
                }
                if (errorVariants.length > 0) {
                  modItems.push({ kind: "attr", code: '@tag("status")' });
                  modItems.push({ kind: "attr", code: `@editor.completeFrom(Operations.${mod})` });
                  const cases = errorVariants.map((v) => ({ label: v.label, payload: v.payload, attr: v.attr }));
                  modItems.push({ kind: "type", keyword: "type", name: "error", body: adtIR(cases) });
                } else {
                  modItems.push({ kind: "type", keyword: "type", name: "error", body: rawIR("unknown") });
                }
              }

              opsItems.push({ kind: "module", name: mod, items: modItems });
            }
          }
        }
      }
    }
  };

  emitCallbacks(paths);

  return { kind: "module", name: "Operations", items: opsItems };
}

// Provide a brief reason for JSON.t fallbacks rendered in fields
function docForJSONFallback(typ: TypeIR): string | undefined {
  try {
    const printed = printTypeIR(typ).replace(/\s+/g, "");
    const isNullWrapped = /^Null\.t<.+>$/.test(printed);
    const inner = isNullWrapped ? printed.replace(/^Null\.t</, "").replace(/>$/, "") : printed;
    let reason: string | undefined;
    if (inner === "JSON.t") {
      reason = "Free-form JSON fallback: schema is unconstrained or not safely mappable.";
    } else if (inner === "array<JSON.t>") {
      reason = "Free-form JSON array: item schema is unconstrained.";
    } else if (inner === "dict<JSON.t>") {
      reason = "Free-form JSON map: value schema is unconstrained (additionalProperties/patternProperties).";
    }
    if (reason && isNullWrapped) return `Nullable; ${reason}`;
    return reason;
  } catch (_e) {
    return undefined;
  }
}
function buildPaths(
  paths: PathsObject | undefined,
  ctx: RSContext
): { nodes: RSNode[]; hasClient: boolean } {
  const nodes: RSNode[] = [];
  const METHODS: (keyof PathItemObject)[] = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];

  type MethodEntry = { method: keyof PathItemObject; opId: string };
  type PathEntry = { path: string; entries: MethodEntry[] };
  const pathEntries: PathEntry[] = [];
  if (paths && typeof paths === "object") {
    for (const [p, item] of Object.entries(paths)) {
      const entries: MethodEntry[] = [];
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        if (!opId || opId.length === 0) continue;
        entries.push({ method: m, opId });
      }
      pathEntries.push({ path: p, entries });
    }
  }

  const usedNames = new Set<string>();
  const typeNameForPath = (pe: PathEntry): string => {
    const primary = pe.entries[0]?.opId;
    let base = `${toValidTypeName(primary ?? pe.path)}_operations`;
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}_${i++}`;
    usedNames.add(name);
    return name;
  };

  const clientFields: string[] = [];
  for (const pe of pathEntries) {
    if (pe.entries.length === 0) continue;
    if ((ctx.includePaths && ctx.includePaths.size > 0) || (ctx.includePathPrefixes && ctx.includePathPrefixes.size > 0)) {
      if (!pathIsIncluded(pe.path, ctx)) {
      // Excluded path: client maps to not_generated
        clientFields.push(`${JSON.stringify(pe.path)}: not_generated,`);
        continue;
      }
    }
    const typeName = typeNameForPath(pe);
    const fields: FieldIR[] = [];
    for (const e of pe.entries) {
      const mod = toValidModuleName(e.opId);
      const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
      const target = toValidResFieldName(e.method);
      const asAttr = `@as(${JSON.stringify(e.method.toUpperCase())}) `;
      fields.push({ name: target.rendered, attr: asAttr, typ: rawIR(fnType) });
    }
    nodes.push({ kind: "type", keyword: "type", name: typeName, body: recordIR(fields) });
    nodes.push({ kind: "blank" });
    clientFields.push(`${JSON.stringify(pe.path)}: ${typeName},`);
  }

  let hasClient = false;
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    nodes.push({ kind: "type", keyword: "type", name: "client", body: rawIR(`\n{.\n${indentLines(rows, 2)}\n}`) });
    hasClient = true;
  }
  return { nodes, hasClient };
}

function buildWebhooks(
  webhooks: OpenAPI3["webhooks"] | undefined,
  ctx: RSContext
): { nodes: RSNode[] } {
  // When filtering by paths, skip top-level webhooks (not associated with a specific path)
  if ((ctx.includePaths && ctx.includePaths.size > 0) || (ctx.includePathPrefixes && ctx.includePathPrefixes.size > 0)) {
    return { nodes: [] };
  }
  const nodes: RSNode[] = [];
  const METHODS: (keyof PathItemObject)[] = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];

  type MethodEntry = { method: keyof PathItemObject; opId: string };
  type HookEntry = { name: string; entries: MethodEntry[] };
  const hookEntries: HookEntry[] = [];
  if (webhooks && typeof webhooks === "object") {
    for (const [name, item] of Object.entries(webhooks)) {
      const entries: MethodEntry[] = [];
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        const effective = opId && opId.length > 0 ? opId : `${name}_${m}`;
        entries.push({ method: m, opId: effective });
      }
      hookEntries.push({ name, entries });
    }
  }

  for (const he of hookEntries) {
    if (he.entries.length === 0) continue;
    const fields: FieldIR[] = [];
    for (const e of he.entries) {
      const mod = toValidModuleName(e.opId);
      const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
      const target = toValidResFieldName(e.method);
      const asAttr = `@as(${JSON.stringify(e.method.toUpperCase())}) `;
      fields.push({ name: target.rendered, attr: asAttr, typ: rawIR(fnType) });
    }
    nodes.push({ kind: "type", keyword: "type", name: toValidTypeName(`${he.name}_webhook`), body: recordIR(fields) });
    nodes.push({ kind: "blank" });
  }

  const clientFields: string[] = [];
  for (const he of hookEntries) {
    if (he.entries.length === 0) continue;
    clientFields.push(`${JSON.stringify(he.name)}: ${toValidTypeName(`${he.name}_webhook`)},`);
  }
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    nodes.push({ kind: "type", keyword: "type", name: "webhooks", body: rawIR(`\n{.\n${indentLines(rows, 2)}\n}`) });
  }
  return { nodes };
}

function buildCallbacks(
  paths: PathsObject | undefined,
  ctx: RSContext
): { nodes: RSNode[] } {
  const nodes: RSNode[] = [];
  const METHODS: (keyof PathItemObject)[] = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ];

  type OpCbEntry = { opId: string; fields: string[] };
  const entriesByOp: Map<string, OpCbEntry> = new Map();

  if (paths && typeof paths === "object") {
    for (const [p, item] of Object.entries(paths)) {
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId =
          op.operationId && op.operationId.length > 0
            ? op.operationId
            : `${String(p)}_${String(m)}`;
        const callbacks = op.callbacks;
        if (!callbacks || typeof callbacks !== "object") continue;
        for (const [cbName, cbVal] of Object.entries(callbacks)) {
          const cbResolved =
            cbVal && isRef(cbVal)
              ? ctx.resolve<CallbackObject>(cbVal.$ref)
              : cbVal;
          if (!cbResolved || typeof cbResolved !== "object") continue;
          for (const [, cbPathItemLike] of Object.entries(cbResolved)) {
            const cbItem =
              cbPathItemLike && isRef(cbPathItemLike)
                ? ctx.resolve<PathItemObject>(cbPathItemLike.$ref)
                : cbPathItemLike;
            if (!cbItem || typeof cbItem !== "object") continue;
            for (const m2 of METHODS) {
              const cbOp = resolveOperation(cbItem[m2], ctx);
              if (!cbOp) continue;
              const mod = toValidModuleName(`${opId}_${cbName}_${m2}`);
              const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
              const target = toValidResFieldName(`${cbName}_${m2}`);
              const asAttr = `@as(${JSON.stringify(m2.toUpperCase())}) `;
              const f = `${asAttr}${target.rendered}: ${fnType},`;
              const ent = entriesByOp.get(opId) ?? { opId, fields: [] };
              ent.fields.push(f);
              entriesByOp.set(opId, ent);
            }
          }
        }
      }
    }
  }

  const clientFields: string[] = [];
  for (const ent of entriesByOp.values()) {
    if (ent.fields.length === 0) continue;
    const tn = toValidTypeName(`${ent.opId}_callbacks`);
    nodes.push({ kind: "type", keyword: "type", name: tn, body: rawIR(`\n{\n${indentLines(ent.fields, 2)}\n}`) });
    nodes.push({ kind: "blank" });
    clientFields.push(`${JSON.stringify(ent.opId)}: ${tn},`);
  }
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    nodes.push({ kind: "type", keyword: "type", name: "callbacks", body: rawIR(`\n{.\n${indentLines(rows, 2)}\n}`) });
  }
  return { nodes };
}
