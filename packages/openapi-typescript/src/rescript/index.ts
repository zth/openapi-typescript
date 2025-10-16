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

function stripLastComma(lines: string[]): string[] {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  const out = [...lines];
  out[out.length - 1] = out[out.length - 1]!.replace(/,\s*$/, "");
  return out;
}

function mapPrimitive(schema: SchemaObject): string | undefined {
  const t = schema.type;
  if (t === "string") return "string";
  if (t === "number" || t === "integer") return "float";
  if (t === "boolean") return "bool";
  return undefined;
}

function shortHash(s: string): string {
  let h = 0 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).slice(0, 6);
}

// Strip a leading doc block (/** ... */) if present to simplify pattern checks
function stripLeadingDoc(s: string): string {
  const t = s.trimStart();
  if (t.startsWith("/**")) {
    const i = t.indexOf("*/");
    if (i >= 0) return t.slice(i + 2).trimStart();
  }
  return t;
}

// Hoist inline record literals that appear inside wrappers like Null.t< { .. } >, array<{..}>, dict<{..}>
// This centralizes detection to minimize scattered regex heuristics. It relies on content-hash-based
// aux naming for stability.
function hoistInlineRecordsInWrappers(
  ty: string,
  collectAux: ((name: string, body: string) => void) | undefined,
  parentName?: string
): string {
  if (typeof collectAux !== "function") return ty;
  let out = ty;
  let changed = true;
  const mkName = (body: string, baseHint?: string): string => {
    const base = toValidTypeName(`${parentName ?? "t"}_${baseHint ?? "shape"}`);
    return nameWithHash(base, body);
  };
  const replaceOnce = (s: string): { s: string; changed: boolean } => {
    let t = s;
    const tryReplace = (
      pattern: RegExp,
      make: (recBody: string) => string
    ): boolean => {
      const m = stripLeadingDoc(t).match(pattern);
      if (!m) return false;
      const rec = m[1]!;
      const aux = mkName(rec);
      collectAux(aux, rec);
      t = t.replace(pattern, make(rec).replace(rec, aux));
      return true;
    };
    // 1) Null.t<{...}>
    if (
      tryReplace(/^Null\.t<\s*(\{[\s\S]*\})\s*>\s*$/, (rec) => `Null.t<${rec}>`)
    )
      return { s: t, changed: true };
    // 2) array<{...}>
    if (tryReplace(/^array<\s*(\{[\s\S]*\})\s*>\s*$/, (rec) => `array<${rec}>`))
      return { s: t, changed: true };
    // 3) dict<{...}>
    if (tryReplace(/^dict<\s*(\{[\s\S]*\})\s*>\s*$/, (rec) => `dict<${rec}>`))
      return { s: t, changed: true };
    // 4) array<Null.t<{...}>> (nesting)
    if (
      tryReplace(
        /^array<\s*Null\.t<\s*(\{[\s\S]*\})\s*>\s*>\s*$/,
        (rec) => `array<Null.t<${rec}>>`
      )
    )
      return { s: t, changed: true };
    // 5) dict<Null.t<{...}>> (nesting)
    if (
      tryReplace(
        /^dict<\s*Null\.t<\s*(\{[\s\S]*\})\s*>\s*>\s*$/,
        (rec) => `dict<Null.t<${rec}>>`
      )
    )
      return { s: t, changed: true };
    return { s: t, changed: false };
  };
  while (changed) {
    const res = replaceOnce(out.trim());
    out = res.s;
    changed = res.changed;
  }
  return out;
}

function nameWithHash(base: string, body: string): string {
  let content = body.trimStart();
  if (content.startsWith("/**")) {
    const idx = content.indexOf("*/");
    if (idx >= 0) content = content.slice(idx + 2).trimStart();
  }
  const h = shortHash(content);
  return `${base}__h${h}`;
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
  propName: string
): TypeIR {
  if (typ.kind === "record" && typeof collectAux === "function") {
    const printed = printTypeIR(typ);
    const baseParent = parentName ?? "t";
    const propBase = toValidTypeName(`${baseParent}_${propName}`);
    const auxName = nameWithHash(propBase, printed);
    collectAux(auxName, printed);
    return refIR(auxName);
  }
  if (isNullApp(typ) && typ.args[0]!.kind === "record" && typeof collectAux === "function") {
    const rec = typ.args[0]!;
    const printed = printTypeIR(rec);
    const baseParent = parentName ?? "t";
    const propBase = toValidTypeName(`${baseParent}_${propName}`);
    const auxName = nameWithHash(propBase, printed);
    collectAux(auxName, printed);
    return appIR(refIR("Null.t"), [refIR(auxName)]);
  }
  return typ;
}

function isRefNamed(t: TypeIR, name: string): boolean {
  return t.kind === "ref" && t.path.join(".") === name;
}

function isArrayIR(t: TypeIR): t is Extract<TypeIR, { kind: "app" }> & { callee: Extract<TypeIR, { kind: "ref" }> } {
  return t.kind === "app" && t.callee.kind === "ref" && t.callee.path.join(".") === "array" && t.args.length === 1;
}

function chooseNarrowerIR(a: TypeIR, b: TypeIR): "a" | "b" | undefined {
  if (alphaEq(a, b)) return "a";
  const aNull = isNullApp(a);
  const bNull = isNullApp(b);
  if (!!aNull && !bNull) return "a";
  if (!!bNull && !aNull) return "b";
  const aCore = aNull ? aNull.args[0]! : a;
  const bCore = bNull ? bNull.args[0]! : b;
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
  // Shared helper: register an allOf fallback alias with a standardized doc block
  const collectAllOfFallback = (reason: string): string => {
    const aux = toValidTypeName(`${parentName ?? "t"}__allOf_fallback`);
    const doc = wrapBlockDoc(`TODO: cannot safely merge allOf: ${reason}`);
    const body = `${doc ? doc + "\n" : ""}JSON.t`;
    if (typeof collectAux === "function") collectAux(aux, body);
    return aux;
  };
  if (isRef(schema)) {
    const ref = schema.$ref;
    // Handle references to $defs: map to `<parent>__def_<name>` pattern so that cross-schema refs work
    if (typeof ref === "string" && ref.includes("/$defs/")) {
      // Case 1: robust parse: extract segment before "$defs" and the def key
      const idx = ref.indexOf("/$defs/");
      if (idx >= 0) {
        const before = ref.slice(0, idx);
        const after = ref.slice(idx + "/$defs/".length);
        const schemaSeg = before.split("/").filter(Boolean).pop();
        const defSeg = after.split("/")[0];
        if (schemaSeg && defSeg) {
          const schemaNm = toValidTypeName(schemaSeg);
          const defNm = toValidTypeName(defSeg);
          return `${schemaNm}__def_${defNm}`;
        }
      }
      // Case 2: local within current schema: #/$defs/<Def>
      const m2 = ref.match(/#\/$defs\/([^/]+)$/);
      if (m2 && parentName) {
        const defNm = toValidTypeName(m2[1]!);
        return `${parentName}__def_${defNm}`;
      }
    }
    const nm = refName(ref);
    return nm ?? "unknown";
  }

  const s: SchemaObject = schema;

  // enums: strings or numbers → PV union with deterministic ordering
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const vals = s.enum;
    const allStrings = vals.every((v) => typeof v === "string");
    const allNumbers = vals.every((v) => typeof v === "number");
    if (allStrings || allNumbers) {
      const sorted = [...vals].sort((a, b) =>
        String(a).localeCompare(String(b))
      );
      const label = (v: string): string => {
        const isIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
        const isReserved = RES_KEYWORDS.has(v);
        return isIdent && !isReserved ? `#${v}` : `#${JSON.stringify(v)}`;
      };
      const tags = sorted.map((v) => label(String(v)));
      const pv = `[${tags.join(" | ")}]`;
      return s.nullable ? `Null.t<${pv}>` : pv;
    }
  }

  // Hoist $defs within this schema into aux types on the same rec chain
  if (hasDefs(s) && typeof collectAux === "function") {
    for (const [k, v] of Object.entries(s.$defs)) {
      const auxName = `${parentName ?? "t"}__def_${toValidTypeName(k)}`;
      const body = mapSchemaToRes(v, ctx, {
        parentName: auxName,
        collectAux,
        optionalAsOption,
      });
      collectAux(auxName, body);
    }
  }

  // basic primitives (including type arrays with null)
  if (Array.isArray(s.type)) {
    const arr = s.type;
    const hasNull = arr.includes("null");
    const others = arr.filter((t) => t !== "null");
    if (hasNull && others.length === 1) {
      const tmp: SchemaObject = {
        ...s,
        type: others[0],
      };
      let inner = mapSchemaToRes(tmp, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
      inner = hoistInlineRecordsInWrappers(inner, collectAux, parentName);
      return `Null.t<${inner}>`;
    }
  }
  const prim = mapPrimitive(s);
  if (prim) {
    const base = s.nullable ? `Null.t<${prim}>` : prim;
    return hoistInlineRecordsInWrappers(base, collectAux, parentName);
  }

  // arrays
  if (isArraySchema(s)) {
    let inner = "unknown";
    if ("items" in s && s.items && !Array.isArray(s.items)) {
      inner = mapSchemaToRes(s.items, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
    }
    if (/^\s*\{/.test(inner) && typeof collectAux === "function") {
      const base = toValidTypeName(`${parentName ?? "t"}_item`);
      const nm = nameWithHash(base, inner);
      collectAux(nm, inner);
      inner = nm;
    }
    let arr = `array<${inner}>`;
    arr = hoistInlineRecordsInWrappers(arr, collectAux, parentName);
    return s.nullable ? `Null.t<${arr}>` : arr;
  }

  // composition: oneOf / anyOf → PV union wrapped in Wrapped.t when possible
  const unionMembers = s.oneOf ?? s.anyOf;
  if (Array.isArray(unionMembers) && unionMembers.length > 0) {
    const isInlineRecordLike = (s: string): boolean => {
      const t = stripLeadingDoc(s);
      const patterns = [
        /^\{/,
        /^Null\.t<\s*\{/,
        /^array<\s*\{/,
        /^dict<\s*\{/,
        /^array<\s*Null\.t<\s*\{/,
      ];
      return patterns.some((re) => re.test(t));
    };
    const isNullTypeSchema = (m: SchemaLike | SchemaObject): boolean => {
      let mm: SchemaObject | undefined;
      if (isRef(m)) mm = ctx.resolve<SchemaObject>(m.$ref);
      else mm = m;
      if (!mm) return false;
      if (mm.type === "null") return true;
      if (Array.isArray(mm.type)) {
        const arr = mm.type;
        return arr.includes("null") && arr.length === 1;
      }
      if (Array.isArray(mm.enum)) {
        return mm.enum.length === 1 && mm.enum[0] == null;
      }
      return false;
    };
    type Member = SchemaLike;
    const members: Member[] = unionMembers;
    // Special-case: union of exactly one non-null + null → Null.t<nonNull>
    const nonNullMembers = members.filter((m) => !isNullTypeSchema(m));
    const nullMembers = members.length - nonNullMembers.length;
    if (nullMembers >= 1 && nonNullMembers.length === 1) {
      const mapped = mapSchemaToRes(nonNullMembers[0]!, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
      return `Null.t<${mapped}>`;
    }
    const allRefs = members.every((m) => isRef(m));
    // Prepare discriminator mapping if present
    const disc: DiscriminatorObject | undefined = s.discriminator;
    let mapRefNameToLabel: Map<string, string> | undefined;
    if (
      disc &&
      typeof disc === "object" &&
      disc.mapping &&
      typeof disc.mapping === "object"
    ) {
      mapRefNameToLabel = new Map<string, string>();
      for (const [val, refStr] of Object.entries(disc.mapping)) {
        const rn = typeof refStr === "string" ? refName(refStr) : undefined;
        if (rn) mapRefNameToLabel.set(rn, toValidModuleName(val));
      }
    }
    if (allRefs) {
      // Union of refs → Wrapped.t of PV constructors referencing component types
      const seen = new Set<string>();
      const ctors: string[] = [];
      const refMembers = members.filter(isRef);
      for (const m of refMembers) {
        const $ref = m.$ref;
        const typeNm = refName($ref) ?? "unknown";
        // Infer label from discriminator property when mapping is absent
        let inferred: string | undefined;
        if (disc && disc.propertyName) {
          const resolved = ctx.resolve<SchemaObject>($ref);
          const propName = disc.propertyName;
          if (resolved && typeof resolved === "object") {
            let props: Record<string, SchemaLike> = {};
            if ("properties" in resolved && resolved.properties) {
              props = resolved.properties;
            }
            const ds = props ? props[propName] : undefined;
            const dso = ds
              ? isRef(ds)
                ? ctx.resolve<SchemaObject>(ds.$ref)
                : ds
              : undefined;
            const val =
              dso &&
              typeof dso === "object" &&
              ("const" in dso
                ? dso.const
                : Array.isArray(dso.enum) && dso.enum.length === 1
                  ? dso.enum[0]
                  : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
        }
        let label =
          mapRefNameToLabel?.get(typeNm) ??
          inferred ??
          toValidModuleName(typeNm);
        // ensure unique labels if duplicates
        let uniq = label;
        let i = 2;
        while (seen.has(uniq)) uniq = `${label}_${i++}`;
        seen.add(uniq);
        ctors.push(`#${uniq}(${typeNm})`);
      }
      const pv = `[${ctors.join(" | ")}]`;
      const wrapped = `Wrapped.t<${pv}>`;
      return s.nullable ? `Null.t<${wrapped}>` : wrapped;
    }

    // Mixed/inline members: generate aux types for inline object members to avoid inline records in PV payloads
    const seen = new Set<string>();
    const ctors: string[] = [];
    members.forEach((m, idx) => {
      if (isRef(m)) {
        const $ref = m.$ref;
        const typeNm = refName($ref) ?? "unknown";
        let inferred: string | undefined;
        if (disc && disc.propertyName) {
          const resolved = ctx.resolve<SchemaObject>($ref);
          const propName = disc.propertyName;
          if (resolved && typeof resolved === "object") {
            let props: Record<string, SchemaLike> = {};
            if ("properties" in resolved && resolved.properties) {
              props = resolved.properties;
            }
            const ds = props ? props[propName] : undefined;
            const dso = ds
              ? isRef(ds)
                ? ctx.resolve<SchemaObject>(ds.$ref)
                : ds
              : undefined;
            const val =
              dso &&
              typeof dso === "object" &&
              ("const" in dso
                ? dso.const
                : Array.isArray(dso.enum) && dso.enum.length === 1
                  ? dso.enum[0]
                  : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
        }
        let label =
          mapRefNameToLabel?.get(typeNm) ??
          inferred ??
          toValidModuleName(typeNm);
        let uniq = label;
        let i = 2;
        while (seen.has(uniq)) uniq = `${label}_${i++}`;
        seen.add(uniq);
        ctors.push(`#${uniq}(${typeNm})`);
      } else {
        // Map the member; if it is an inline record, lift to an aux type
        const mapped = mapSchemaToRes(m, ctx, {
          parentName,
          collectAux,
          optionalAsOption,
        });
        const inlineLike = isInlineRecordLike(mapped);
        if (inlineLike && typeof collectAux === "function") {
          const base = toValidTypeName(
            `${parentName ?? "t"}_member_${idx + 1}`
          );
          let auxName = nameWithHash(base, mapped);
          // naive uniqueness: try suffix increment until no clash
          let j = 2;
          // We cannot check global uniqueness here; assume caller places within single rec chain and base is unique per parent
          collectAux(auxName, mapped);
          // Try infer label from inline member's discriminator property
          let inferred: string | undefined;
          if (
            disc &&
            disc.propertyName &&
            m &&
            typeof m === "object" &&
            !isRef(m)
          ) {
            const propName = disc.propertyName;
            const mm = m;
            let props: Record<string, SchemaLike> = {};
            if ("properties" in mm && mm.properties) {
              props = mm.properties;
            }
            const ds = props ? props[propName] : undefined;
            const dso = ds
              ? isRef(ds)
                ? ctx.resolve<SchemaObject>(ds.$ref)
                : ds
              : undefined;
            const val =
              dso &&
              typeof dso === "object" &&
              ("const" in dso
                ? dso.const
                : Array.isArray(dso.enum) && dso.enum.length === 1
                  ? dso.enum[0]
                  : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
          let label = inferred ?? toValidModuleName(`Member${idx + 1}`);
          let uniq = label;
          let k = 2;
          while (seen.has(uniq)) uniq = `${label}_${k++}`;
          seen.add(uniq);
          ctors.push(`#${uniq}(${auxName})`);
        } else {
          // Non-record or no collector: inline directly as payload type
          let inferred: string | undefined;
          if (
            disc &&
            disc.propertyName &&
            m &&
            typeof m === "object" &&
            !isRef(m)
          ) {
            const propName = disc.propertyName;
            const mm = m;
            let props: Record<string, SchemaLike> = {};
            if ("properties" in mm && mm.properties) {
              props = mm.properties;
            }
            const ds = props ? props[propName] : undefined;
            const dso = ds
              ? isRef(ds)
                ? ctx.resolve<SchemaObject>(ds.$ref)
                : ds
              : undefined;
            const val =
              dso &&
              typeof dso === "object" &&
              ("const" in dso
                ? dso.const
                : Array.isArray(dso.enum) && dso.enum.length === 1
                  ? dso.enum[0]
                  : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
          let label = inferred ?? toValidModuleName(`Member${idx + 1}`);
          let uniq = label;
          let k = 2;
          while (seen.has(uniq)) uniq = `${label}_${k++}`;
          seen.add(uniq);
          ctors.push(`#${uniq}(${mapped})`);
        }
      }
    });
    const pv = `[${ctors.join(" | ")}]`;
    const wrapped = `Wrapped.t<${pv}>`;
    return s.nullable ? `Null.t<${wrapped}>` : wrapped;
  }

  // (enum mapping handled above)

  // objects with properties
  if (s.type === "object" || ("properties" in s && s.properties)) {
    const required = new Set<string>(s.required ?? []);
    let props: Record<string, SchemaLike> = {};
    if ("properties" in s && s.properties) props = s.properties;
    const fields: string[] = [];
    const used: Set<string> = new Set();
    const propEntries = getEntries<SchemaLike>(props);

    // patternProperties → treat as dict<JSON.t> when no explicit properties
    const patternProps =
      "patternProperties" in s ? s.patternProperties : undefined;
    if (
      propEntries.length === 0 &&
      patternProps &&
      typeof patternProps === "object" &&
      Object.keys(patternProps).length > 0
    ) {
      return s.nullable ? `Null.t<dict<JSON.t>>` : `dict<JSON.t>`;
    }

    // If no explicit properties and we only have additionalProperties, treat as dict
    if (
      propEntries.length === 0 &&
      "additionalProperties" in s &&
      s.additionalProperties !== undefined
    ) {
      const ap = s.additionalProperties;
      if (ap === true) {
        return s.nullable ? `Null.t<dict<JSON.t>>` : `dict<JSON.t>`;
      }
      if (ap === false) {
        return s.nullable ? `Null.t<emptyObject>` : `emptyObject`;
      }
      let inner = mapSchemaToRes(ap as SchemaObject | ReferenceObject, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
      if (/^\s*\{/.test(inner) && typeof collectAux === "function") {
        const base = toValidTypeName(`${parentName ?? "t"}_value`);
        const nm = nameWithHash(base, inner);
        collectAux(nm, inner);
        inner = nm;
      }
      let dict = `dict<${inner}>`;
      dict = hoistInlineRecordsInWrappers(dict, collectAux, parentName);
      return s.nullable ? `Null.t<${dict}>` : dict;
    }

    for (const [propName, propSchema] of propEntries) {
      let mapped = mapSchemaToRes(propSchema, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
      // Avoid deep inline-record nesting: hoist inline records as aux types when possible
      if (/^\s*\{/.test(mapped) && typeof collectAux === "function") {
        const baseParent = parentName ?? "t";
        const propBase = toValidTypeName(`${baseParent}_${propName}`);
        const auxName = nameWithHash(propBase, mapped);
        collectAux(auxName, mapped);
        mapped = auxName;
      } else if (
        /^\s*Null\.t<\s*\{/.test(mapped) &&
        typeof collectAux === "function"
      ) {
        // Also hoist when a nullable inline record appears inside Null.t< {...} >
        const m = mapped.match(/^\s*Null\.t<\s*(\{[\s\S]*\})\s*>\s*$/);
        if (m) {
          const baseParent = parentName ?? "t";
          const propBase = toValidTypeName(`${baseParent}_${propName}`);
          const auxName = nameWithHash(propBase, m[1]!);
          collectAux(auxName, m[1]!);
          mapped = `Null.t<${auxName}>`;
        }
      }
      const isReq = required.has(propName);
      const { rendered, attr } = toValidResFieldName(propName);
      // naive unique handling: suffix if duplicate
      let name = rendered;
      let i = 2;
      while (used.has(name)) name = `${rendered}__${i++}`;
      used.add(name);
      let line: string;
      if (isReq) {
        line = `${attr ?? ""}${name}: ${mapped},`;
      } else if (optionalAsOption) {
        const m = mapped.trim();
        const nullMatch = m.match(/^Null\.t<(.+)>$/);
        if (nullMatch) {
          line = `${attr ?? ""}${name}: Nullable.t<${nullMatch[1]}>,`;
        } else {
          line = `${attr ?? ""}${name}: option<${mapped}>,`;
        }
      } else {
        line = `${attr ?? ""}${name}?: ${mapped},`;
      }
      const propDoc = wrapBlockDoc(propSchema.description);
      if (propDoc) fields.push(propDoc);
      fields.push(line);
    }
    const body = `\n{\n${indentLines(fields, 2)}\n}`;
    if (s.nullable) {
      if (typeof collectAux === "function") {
        const auxName = nameWithHash(
          toValidTypeName(`${parentName ?? "t"}__shape`),
          body
        );
        collectAux(auxName, body);
        return `Null.t<${auxName}>`;
      }
      return `Null.t<${body}>`;
    }
    return body;
  }

  // composition: allOf → merge object-like members where possible; otherwise fallback alias with TODO
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    const members = s.allOf!;

    const tryInlineObject = (v: SchemaLike): SchemaObject | undefined => {
      let node: SchemaObject | undefined;
      if (isRef(v)) node = ctx.resolve<SchemaObject>(v.$ref);
      else node = v;
      if (!node) return undefined;
      if (Array.isArray(node.allOf) && node.allOf.length > 0) {
        for (const m of node.allOf) {
          const obj = tryInlineObject(m);
          if (obj) return obj;
        }
      }
      if (
        node.type === "object" ||
        "properties" in node ||
        "additionalProperties" in node
      )
        return node;
      return undefined;
    };

    const isAnnotationOnly = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const keys = Object.keys(node as Record<string, unknown>);
      const structural = [
        "type",
        "properties",
        "required",
        "additionalProperties",
        "oneOf",
        "anyOf",
        "allOf",
        "$ref",
        "items",
        "enum",
        "const",
        "patternProperties",
      ];
      const onlyAnn = keys.every((k) =>
        [
          "title",
          "description",
          "deprecated",
          "readOnly",
          "writeOnly",
          "examples",
          "example",
        ].includes(k)
      );
      return onlyAnn;
    };

    const isPVUnion = (t: string): boolean => /^\[\s*#/.test(t.trim());
    const isNullWrapped = (t: string): boolean => /^\s*Null\.t</.test(t);
    const unwrapNull = (t: string): string =>
      isNullWrapped(t) ? t.replace(/^\s*Null\.t</, "").replace(/>\s*$/, "") : t;
    const isArrayType = (
      t: string
    ): { ok: true; inner: string } | { ok: false } => {
      const m = t.trim().match(/^array<(.+)>$/);
      return m ? { ok: true, inner: m[1]!.trim() } : { ok: false };
    };
    const parsePV = (t: string): string[] | undefined => {
      const m = t.trim().match(/^\[\s*(.+)\s*\]$/);
      if (!m) return undefined;
      return m[1]!
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const chooseNarrower = (
      aTy: string,
      bTy: string
    ): "a" | "b" | undefined => {
      if (aTy === bTy) return "a";
      // Null-wrapped preference
      const aNull = isNullWrapped(aTy);
      const bNull = isNullWrapped(bTy);
      if (aNull && !bNull) return "a";
      if (bNull && !aNull) return "b";
      // Array inner preference (recurse on inner)
      const aArr = isArrayType(unwrapNull(aTy));
      const bArr = isArrayType(unwrapNull(bTy));
      if (aArr.ok && bArr.ok) {
        const res = chooseNarrower(aArr.inner, bArr.inner);
        return res ?? "a";
      }
      // PV union is narrower than string/float
      if (
        (aTy === "string" && isPVUnion(bTy)) ||
        (aTy === "float" && isPVUnion(bTy))
      )
        return "b";
      if (
        (bTy === "string" && isPVUnion(aTy)) ||
        (bTy === "float" && isPVUnion(aTy))
      )
        return "a";
      // Alias vs primitive: prefer alias (more informative)
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

    const isArraySchema = (v: SchemaLike | SchemaObject): SchemaObject | undefined => {
      const node = isRef(v)
        ? ctx.resolve<SchemaObject>(v.$ref)
        : v;
      if (!node || typeof node !== "object") return undefined;
      const hasPrefixItems =
        "prefixItems" in node && Array.isArray(node.prefixItems);
      if (
        node.type === "array" ||
        ("items" in node && node.items != null) ||
        hasPrefixItems
      )
        return node;
      if (Array.isArray(node.allOf)) {
        for (const m of node.allOf) {
          const got = isArraySchema(m);
          if (got) return got;
        }
      }
      return undefined;
    };

    const isScalarSchema = (v: SchemaLike | SchemaObject): v is SchemaObject => {
      let node: SchemaObject | undefined;
      if (isRef(v)) node = ctx.resolve<SchemaObject>(v.$ref);
      else node = v;
      if (!node || typeof node !== "object") return false;
      if ("const" in node) return true;
      if (Array.isArray(node.enum)) return true;
      const t = node.type;
      return (
        t === "string" || t === "number" || t === "integer" || t === "boolean"
      );
    };

    const resolved: Array<SchemaObject | undefined> = [];
    for (const m of members) {
      if (isRef(m)) resolved.push(ctx.resolve<SchemaObject>(m.$ref));
      else resolved.push(m);
    }
    const topNullable = !!s.nullable || resolved.some((r) => !!r?.nullable);
    // ignore purely annotation members
    const filtered = resolved.filter((r) => !isAnnotationOnly(r));
    const objectLikes = filtered
      .map((r) => tryInlineObject(r))
      .filter((x): x is SchemaObject => Boolean(x));

    // If we have array-like members (and no object-like), merge arrays by narrowing item type
    const arrayLikes = filtered
      .map((r) => isArraySchema(r))
      .filter((x): x is SchemaObject => Boolean(x));
    if (arrayLikes.length > 0 && objectLikes.length === 0) {
      let itemType: string | undefined = undefined;
      for (const a of arrayLikes) {
        let it: SchemaLike | undefined = undefined;
        if ("items" in a && a.items && !Array.isArray(a.items)) {
          it = a.items;
        }
        const mapped = it
          ? mapSchemaToRes(it, ctx, { parentName, collectAux })
          : "unknown";
        if (itemType == null) {
          itemType = mapped;
        } else if (itemType !== mapped) {
          const pref = chooseNarrower(itemType, mapped);
          if (pref === "b") itemType = mapped;
          // if pref === "a" keep existing; if undefined, keep existing to avoid widening
        }
      }
      const arr = `array<${itemType ?? "unknown"}>`;
      if (topNullable) {
        if (typeof collectAux === "function") {
          const auxName = nameWithHash(
            toValidTypeName(`${parentName ?? "t"}__shape`),
            arr
          );
          collectAux(auxName, arr);
          return `Null.t<${auxName}>`;
        }
        return `Null.t<${arr}>`;
      }
      return arr;
    }

    // If all remaining are scalar-like, compute a narrowed scalar type
    const scalarLikes = filtered.filter((r) => isScalarSchema(r));
    if (scalarLikes.length > 0 && objectLikes.length === 0) {
      // Collect enums/consts
      const sets: Array<Set<string>> = [];
      let base: "string" | "float" | "bool" | undefined = undefined;
      for (const s of scalarLikes) {
        if (Array.isArray(s.enum) && s.enum.length > 0) {
          const vals = s.enum.map(
            (v: unknown) => `#${JSON.stringify(String(v))}`
          );
          sets.push(new Set(vals));
          base =
            base ??
            (typeof s.type === "string" &&
            (s.type === "number" || s.type === "integer")
              ? "float"
              : s.type === "boolean"
                ? "bool"
                : "string");
        } else if ("const" in s && s.const !== undefined) {
          const v = `#${JSON.stringify(String(s.const))}`;
          sets.push(new Set([v]));
          base = base ?? "string";
        } else if (typeof s.type === "string") {
          const t = s.type;
          if (t === "number" || t === "integer") base = base ?? "float";
          else if (t === "boolean") base = base ?? "bool";
          else base = base ?? "string";
        }
      }
      let ty: string | undefined = undefined;
      if (sets.length > 0) {
        // Intersect all sets
        let acc = sets[0]!;
        for (let i = 1; i < sets.length; i++) {
          const nxt = sets[i]!;
          acc = new Set([...acc].filter((x) => nxt.has(x)));
        }
        if (acc.size > 0) {
          const pv = `[${[...acc].sort().join(" | ")}]`;
          ty = pv;
        }
      }
      if (!ty) {
        ty = base ?? "unknown";
      }
      return topNullable ? `Null.t<${ty}>` : ty;
    }

    if (objectLikes.length > 0) {
      const required = new Set<string>();
      const baseProps: Record<string, SchemaLike> = {};
      // Merge properties from all object-like members
      for (const obj of objectLikes) {
        const req = Array.isArray(obj.required) ? obj.required : [];
        for (const r of req) required.add(r);
        const props: Record<string, SchemaLike> =
          "properties" in obj && obj.properties ? obj.properties : {};
        for (const [k, v] of Object.entries(props)) {
          if (baseProps[k] == null) baseProps[k] = v;
          else {
            const aTy = mapSchemaToRes(baseProps[k], ctx, {
              parentName,
              collectAux,
              optionalAsOption,
            });
            const bTy = mapSchemaToRes(v, ctx, {
              parentName,
              collectAux,
              optionalAsOption,
            });
            if (aTy !== bTy) {
              const pref = chooseNarrower(aTy, bTy);
              if (pref === "a") {
                // keep existing
                continue;
              } else if (pref === "b") {
                baseProps[k] = v;
                continue;
              } else {
                // Conservative default: keep existing to avoid fallback
                continue;
              }
            }
          }
        }
      }

      // Build merged record
      const fields: string[] = [];
      const used = new Set<string>();
      for (const [propName, propSchema] of Object.entries(baseProps)) {
        let mapped = mapSchemaToRes(propSchema, ctx, {
          parentName,
          collectAux,
          optionalAsOption,
        });
        if (/^\s*\{/.test(mapped) && typeof collectAux === "function") {
          const auxName = toValidTypeName(
            `${parentName ?? "t"}_${String(propName)}`
          );
          collectAux(auxName, mapped);
          mapped = auxName;
        } else if (
          /^\s*Null\.t<\s*\{/.test(mapped) &&
          typeof collectAux === "function"
        ) {
          const m = mapped.match(/^\s*Null\.t<\s*(\{[\s\S]*\})\s*>\s*$/);
          if (m) {
            const auxName = toValidTypeName(
              `${parentName ?? "t"}_${String(propName)}`
            );
            collectAux(auxName, m[1]!);
            mapped = `Null.t<${auxName}>`;
          }
        }
        const isReq = required.has(propName);
        const { rendered, attr } = toValidResFieldName(propName);
        let name = rendered;
        let i = 2;
        while (used.has(name)) name = `${rendered}__${i++}`;
        used.add(name);
        let line: string;
        if (isReq) {
          line = `${attr ?? ""}${name}: ${mapped},`;
        } else if (optionalAsOption) {
          const m = mapped.trim();
          const nullMatch = m.match(/^Null\.t<(.+)>$/);
          if (nullMatch) {
            line = `${attr ?? ""}${name}: Nullable.t<${nullMatch[1]}>,`;
          } else {
            line = `${attr ?? ""}${name}: option<${mapped}>,`;
          }
        } else {
          line = `${attr ?? ""}${name}?: ${mapped},`;
        }
        fields.push(line);
      }
      const body = `\n{\n${indentLines(fields, 2)}\n}`;
      if (topNullable) {
        if (typeof collectAux === "function") {
          const auxName = nameWithHash(
            toValidTypeName(`${parentName ?? "t"}__shape`),
            body
          );
          collectAux(auxName, body);
          return `Null.t<${auxName}>`;
        }
        return `Null.t<${body}>`;
      }
      return body;
    }

    // Fallback: attempt concatenation of object-like members while skipping scalars/annotations
    const lines: string[] = [];
    for (const r of filtered) {
      const obj = tryInlineObject(r);
      if (!obj) continue;
      const mapped = mapSchemaToRes(obj, ctx, {
        parentName,
        collectAux,
        optionalAsOption,
      });
      const m = mapped.trim();
      if (m.startsWith("{") || m.startsWith("{\n")) {
        const body = m.replace(/^\{\n?/, "").replace(/\n?\}$/, "");
        for (const line of body.split("\n").filter(Boolean)) lines.push(line);
      }
    }
    if (lines.length > 0) {
      const body = `\n{\n${lines.join("\n")}\n}`;
      if (topNullable) {
        if (typeof collectAux === "function") {
          const auxName = nameWithHash(
            toValidTypeName(`${parentName ?? "t"}__shape`),
            body
          );
          collectAux(auxName, body);
          return `Null.t<${auxName}>`;
        }
        return `Null.t<${body}>`;
      }
      return body;
    }

    if (typeof collectAux === "function")
      return collectAllOfFallback("non-object member(s)");
    return "JSON.t";
  }

  return "unknown";
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
  }: {
    parentName?: string;
    collectAux?: (name: string, body: string) => void;
    optionalAsOption?: boolean;
  } = {}
): TypeIR {
  // Pre-hoist $defs if present (mirrors string path behavior)
  if (!isRef(schema)) {
    const s: SchemaObject = schema;
    // Basic primitives and nullable type arrays → IR
    if (Array.isArray((s as any).type)) {
      const arr = (s as any).type as unknown[];
      const hasNull = arr.includes("null");
      const others = arr.filter((t) => t !== "null");
      if (hasNull && others.length === 1) {
        const tmp: SchemaObject = { ...s, type: others[0] as any };
        const inner = mapSchemaToIR(tmp, ctx, { parentName, collectAux, optionalAsOption });
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
    // composition: oneOf / anyOf → PV union wrapped in Wrapped.t when possible
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
        return false;
      };
      const nonNullMembers = unionMembers.filter((m) => !isNullTypeSchema(m));
      const nullMembers = unionMembers.length - nonNullMembers.length;
      if (nullMembers >= 1 && nonNullMembers.length === 1) {
        const inner = mapSchemaToIR(nonNullMembers[0]!, ctx, { parentName, collectAux, optionalAsOption });
        return appIR(refIR("Null.t"), [inner]);
      }
      const allRefs = unionMembers.every((m) => isRef(m));
      const disc: DiscriminatorObject | undefined = s.discriminator;
      let mapRefNameToLabel: Map<string, string> | undefined;
      if (disc && typeof disc === "object" && disc.mapping && typeof disc.mapping === "object") {
        mapRefNameToLabel = new Map<string, string>();
        for (const [val, refStr] of Object.entries(disc.mapping)) {
          const rn = typeof refStr === "string" ? refName(refStr) : undefined;
          if (rn) mapRefNameToLabel.set(rn, toValidModuleName(val));
        }
      }
      if (allRefs) {
        const seen = new Set<string>();
        const cases: Array<{ label: string; payload?: TypeIR }> = [];
        for (const m of unionMembers) {
          if (!isRef(m)) continue;
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
          let label = mapRefNameToLabel?.get(typeNm) ?? inferred ?? toValidModuleName(typeNm);
          let uniq = label;
          let i = 2;
          while (seen.has(uniq)) uniq = `${label}_${i++}`;
          seen.add(uniq);
          cases.push({ label: `#${uniq}`, payload: refIR(typeNm) });
        }
        const pv = polyIR(cases);
        const wrapped = appIR(refIR("Wrapped.t"), [pv]);
        return s.nullable ? appIR(refIR("Null.t"), [wrapped]) : wrapped;
      }
      // Mixed or inline members
      const seen = new Set<string>();
      const cases: Array<{ label: string; payload?: TypeIR }> = [];
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
          const ir = mapSchemaToIR(m, ctx, { parentName, collectAux, optionalAsOption });
          let payload: TypeIR = ir;
          if (ir.kind === "record" && typeof collectAux === "function") {
            const printed = printTypeIR(ir);
            const base = toValidTypeName(`${parentName ?? "t"}_member_${idx + 1}`);
            const auxName = nameWithHash(base, printed);
            collectAux(auxName, printed);
            payload = refIR(auxName);
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
      const pv = polyIR(cases);
      const wrapped = appIR(refIR("Wrapped.t"), [pv]);
      return s.nullable ? appIR(refIR("Null.t"), [wrapped]) : wrapped;
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
    if (hasDefs(s) && typeof collectAux === "function") {
      for (const [k, v] of Object.entries(s.$defs)) {
        const auxName = `${parentName ?? "t"}__def_${toValidTypeName(k)}`;
        const ir = mapSchemaToIR(v, ctx, {
          parentName: auxName,
          collectAux,
          optionalAsOption,
        });
        collectAux(auxName, printTypeIR(ir));
      }
    }
    // Arrays
    if (s && typeof s === "object" && s.type === "array" && s.items && !Array.isArray(s.items)) {
      let inner = mapSchemaToIR(s.items, ctx, { parentName, collectAux, optionalAsOption });
      if (inner.kind === "record" && typeof collectAux === "function") {
        const printed = printTypeIR(inner);
        const base = toValidTypeName(`${parentName ?? "t"}_item`);
        const nm = nameWithHash(base, printed);
        collectAux(nm, printed);
        inner = refIR(nm);
      }
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
        let inner = mapSchemaToIR(ap, ctx, { parentName, collectAux, optionalAsOption });
        if (inner.kind === "record" && typeof collectAux === "function") {
          const printed = printTypeIR(inner);
          const base = toValidTypeName(`${parentName ?? "t"}_value`);
          const nm = nameWithHash(base, printed);
          collectAux(nm, printed);
          inner = refIR(nm);
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
            let ir = mapSchemaToIR(v, ctx, { parentName, collectAux, optionalAsOption });
            ir = hoistFieldTypeIfNeeded(ir, collectAux, parentName, k);
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
        const fields: FieldIR[] = [];
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
          const field: FieldIR = { name, attr: attr ?? undefined, typ: pIR };
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
          const combined = docParts.length > 0 ? wrapBlockDoc(docParts.join("\n")) : undefined;
          if (combined) field.doc = combined;
          fields.push(field);
        }
        const rec = recordIR(fields);
        if (topNullable) {
          if (typeof collectAux === "function") {
            const printed = printTypeIR(rec);
            const auxName = nameWithHash(toValidTypeName(`${parentName ?? "t"}__shape`), printed);
            collectAux(auxName, printed);
            return rawIR(`Null.t<${auxName}>`);
          }
          return appIR(refIR("Null.t"), [rec]);
        }
        return rec;
      }
      // Arrays/scalars handling via IR
      const arrayMembers = filtered.filter((r) => r && r.type === "array" && r.items && !Array.isArray(r.items)) as Array<SchemaObject & ArraySubtype>;
      if (arrayMembers.length > 0) {
        const itemsIRs = arrayMembers.map((am) => mapSchemaToIR(am.items!, ctx, { parentName, collectAux, optionalAsOption }));
        let chosen = itemsIRs[0]!;
        let note: string | undefined;
        for (let i = 1; i < itemsIRs.length; i++) {
          if (!alphaEq(chosen, itemsIRs[i]!)) {
            note = "TODO: allOf array items differ; using first";
            break;
          }
        }
        // Hoist inline records for items
        if (chosen.kind === "record" && typeof collectAux === "function") {
          const printed = printTypeIR(chosen);
          const base = toValidTypeName(`${parentName ?? "t"}_item`);
          const nm = nameWithHash(base, printed);
          collectAux(nm, printed);
          chosen = refIR(nm);
        }
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
      // Fallback: rely on current string-based mapping
      return rawIR(mapSchemaToRes(schema, ctx, { parentName, collectAux, optionalAsOption }));
    }
    // Only object-with-properties is handled structurally for now.
    if (isObjectSchema(s)) {
      let props: Record<string, SchemaLike> = {};
      const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
      if ("properties" in s && s.properties) props = s.properties;
      const propEntries = getEntries<SchemaLike>(props);
      if (propEntries.length > 0) {
        const used: Set<string> = new Set();
        const fields: FieldIR[] = [];
        for (const [propName, propSchema] of propEntries) {
          // Build IR for the property type
          let pIR = mapSchemaToIR(propSchema, ctx, { parentName, collectAux, optionalAsOption });
          // Hoist inline records under wrappers or as direct property types to reduce nesting
          pIR = hoistFieldTypeIfNeeded(pIR, collectAux, parentName, propName);
          const { rendered, attr } = toValidResFieldName(propName);
          let name = rendered;
          let i = 2;
          while (used.has(name)) name = `${rendered}__${i++}`;
          used.add(name);
          const isReq = required.has(propName);
          const pdoc = wrapBlockDoc(propSchema.description);
          // Optionality handling with IR: option vs Nullable
          const field: FieldIR = { name, attr: attr ?? undefined, typ: pIR };
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
          if (pdoc) field.doc = pdoc;
          fields.push(field);
        }
        const recIR = recordIR(fields);
        if (s.nullable) {
          // Preserve hoisting behavior: avoid inline record inside Null.t by emitting an aux.
          const printed = printTypeIR(recIR);
          const auxName = nameWithHash(toValidTypeName(`${parentName ?? "t"}__shape`), printed);
          if (typeof collectAux === "function") collectAux(auxName, printed);
          return rawIR(`Null.t<${auxName}>`);
        }
        return recIR;
      }
    }
  }
  // Fallback: rely on the current string-based mapping
  return rawIR(
    mapSchemaToRes(schema, ctx, { parentName, collectAux, optionalAsOption })
  );
}

function buildComponentsSchemas(
  components: ComponentsObject | undefined,
  ctx: RSContext
): RSNode {
  const schemasItems: RSNode[] = [];

  const schemas = components?.schemas ?? {};
  const entries = getEntries(schemas, {
    alphabetize: ctx.alphabetize,
    excludeDeprecated: ctx.excludeDeprecated,
  });
  if (entries.length > 0) {
    const declNodes: RSNode[] = [];
    entries.forEach(([name, schema], idx) => {
      const typeName = toValidTypeName(name);
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
      const bodyIR = mapSchemaToIR(schema, ctx, {
        parentName: typeName,
        collectAux: (n, b) => {
          const { doc, code } = splitDocBlock(b);
          aux.push({ name: n, body: withDoc(doc, rawIR(code)) });
        },
        optionalAsOption: true,
      });
      const bodyPrinted = printTypeIR(bodyIR).trim();
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
      const kw: "type rec" | "and" = idx === 0 ? "type rec" : "and";
      const firstBody: TypeIR = withDoc(doc, bodyIR);
      declNodes.push({ kind: "type", keyword: kw, name: typeName, body: firstBody });
      if (aux.length > 0) {
        const seen = new Set<string>();
        for (const t of aux) {
          if (seen.has(t.name)) continue;
          declNodes.push({ kind: "type", keyword: "and", name: t.name, body: t.body });
          seen.add(t.name);
        }
      }
    });
    schemasItems.push(...declNodes);
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
      let actual: string = "string";
      if (header && typeof header === "object") {
        if (header.schema) actual = mapSchemaToRes(header.schema, ctx, {});
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
            actual = mapSchemaToRes(chosenResolved.schema, ctx, {});
          else actual = "unknown";
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
      if (actual !== "string") {
        const doc = wrapBlockDoc(`actual: ${actual}`);
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
  file.push({ kind: "open", name: "OpenAPIFetch" });
  file.push({ kind: "blank" });

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
    file.push({
      kind: "raw",
      code: "let createClient = options => createFetchClient(createClient(options))",
    });
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
  // Bring component schema types into scope for operation payloads
  opsItems.push({ kind: "open", name: "Components.Schemas" });

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
    container?: Record<string, PathItemObject | ReferenceObject> | undefined
  ) => {
    if (!container) return;
    for (const [p, item] of Object.entries(container)) {
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        const opName = opId && opId.length > 0 ? opId : `${String(p)}_${String(m)}`;
        const mod = toValidModuleName(opName);
        const modItems: RSNode[] = [];

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
          let ty = "unknown";
          if (schema) {
            const base = toValidTypeName(`${mod}_${where}_${toValidTypeName(name)}`);
            ty = mapSchemaToRes(schema, ctx, {
              parentName: base,
              collectAux: (n, b) => {
                const { doc, code } = splitDocBlock(b);
                paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
              },
            });
          }
          const fname = toValidResFieldName(name);
          const pdoc = wrapBlockDoc(param.description);
          const field: FieldIR = {
            name: fname.rendered,
            attr: fname.attr ?? undefined,
            typ: rawIR(ty),
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
              optional: "questionMark",
            });
          }
          const paramsBody = recordIR(paramsFields);
          modItems.push({ kind: "type", keyword: "type", name: "params", body: paramsBody });
        }

        // REQUEST BODY
        let bodyType: string | undefined;
        const rb = op.requestBody;
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
              const aux: Array<TypeDeclIR> = [];
              const base = toValidTypeName(`${mod}_request_body`);
              const mapped = mapSchemaToRes(chosenResolved.schema, ctx, {
                parentName: base,
                collectAux: (n, b) => {
                  const { doc, code } = splitDocBlock(b);
                  aux.push({ name: n, body: withDoc(doc, rawIR(code)) });
                },
              });
              if (aux.length > 0) {
                const seenReqAux = new Set<string>();
                for (const t of aux) {
                  if (seenReqAux.has(t.name)) continue;
                  modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                  seenReqAux.add(t.name);
                }
              }
              if (/^\s*\{/.test(mapped)) {
                const { doc: bdoc, code: bcode } = splitDocBlock(mapped);
                modItems.push({ kind: "type", keyword: "type", name: base, body: withDoc(bdoc, rawIR(bcode)) });
                bodyType = base;
              } else {
                bodyType = mapped;
              }
            } else {
              bodyType = "JSON.t";
            }
          }
        }

        // PARAMETERS wrapper
        const parametersFields: string[] = [];
        if (present.size > 0) parametersFields.push("params?: params,");
        if (bodyType) parametersFields.push(`body?: ${bodyType},`);
        if (parametersFields.length > 0) {
          const pBody = rawIR(`\n{\n${indentLines(parametersFields, 2)}\n}`);
          modItems.push({ kind: "type", keyword: "type", name: "parameters", body: pBody });
        } else {
          modItems.push({ kind: "type", keyword: "type", name: "parameters", body: rawIR("emptyObject") });
        }

        // RESPONSES
        const responses = op.responses;
        const successVariants: string[] = [];
        const successPayloadTypes: string[] = [];
        const successStatusCodes: string[] = [];
        const errorVariants: string[] = [];
        const usedSuccessCtors: Set<string> = new Set();
        const usedErrorCtors: Set<string> = new Set();
        const auxTypes: TypeDeclIR[] = [];
        const successAuxTypes: TypeDeclIR[] = [];
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

        if (responses && typeof responses === "object") {
          // Collect success bodies
          const bodies: { code: string; ty: string }[] = [];
          for (const [status, respLike] of Object.entries(responses)) {
            const isDefault = status === "default";
            const n = parseInt(status, 10);
            const is2xx = !isNaN(n) && n >= 200 && n < 300;
            const refNameForCtor = ((): string | undefined => {
              if (isRef(respLike)) {
                const nm = refName(respLike.$ref);
                if (nm) return nm[0]!.toUpperCase() + nm.slice(1);
              }
              return undefined;
            })();
            const resolved = isRef(respLike) ? ctx.resolve<ResponseObject>(respLike.$ref) : respLike;
            const content = resolved && typeof resolved === "object" ? resolved.content : undefined;
            let body: string | undefined;
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
                body = mapSchemaToRes(chosen.schema, ctx, {
                  parentName: base,
                  collectAux: (n, b) => addSuccessAuxType(n, b),
                  optionalAsOption: true,
                });
              } else {
                body = "unknown";
                unknownReason = "no schema for chosen media type";
              }
            } else {
              body = "unit";
              noContent = true;
            }

            if (is2xx) bodies.push({ code: status, ty: body ?? "unknown" });

            // Per-status headers
            const headersVal = resolved && typeof resolved === "object" ? resolved.headers : undefined;
            const headerTypeName = toValidTypeName(`status_${isDefault ? "default" : status}_headers`);
            if (!headerTypeDefs.some((t) => t.name === headerTypeName)) {
              let headerBody: string;
              if (headersVal && typeof headersVal === "object" && Object.keys(headersVal).length > 0) {
                const fields: string[] = [];
                for (const [hname, hlike] of Object.entries(headersVal)) {
                  const header: HeaderObject | undefined = isRef(hlike)
                    ? ctx.resolve<HeaderObject>(hlike.$ref)
                    : hlike;
                  let actual: string = "string";
                  if (header && typeof header === "object") {
                    if (header.schema) {
                      actual = mapSchemaToRes(header.schema, ctx, {});
                    } else if (header.content && typeof header.content === "object") {
                      const ents = Object.entries(header.content);
                      const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                      const chosen = chosenEntry?.[1];
                      const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
                      if (chosenResolved && chosenResolved.schema) actual = mapSchemaToRes(chosenResolved.schema, ctx, {});
                      else actual = "unknown";
                    }
                  }
                  const fn = toValidResFieldName(hname);
                  if (actual !== "string") {
                    const doc = wrapBlockDoc(`actual: ${actual}`);
                    if (doc) fields.push(doc);
                  }
                  fields.push(`${fn.attr ?? ""}${fn.rendered}: option<string>,`);
                }
                headerBody = `\n{\n${indentLines(fields, 2)}\n}`;
              } else {
                headerBody = `emptyObject`;
              }
              headerTypeDefs.push({ name: headerTypeName, body: rawIR(headerBody) });
            }

            // Build variants
            const ctorBase = refNameForCtor ?? "Data";
            const asAttr = isDefault ? `@as("default") ` : !isNaN(n) ? `@as(${status}) ` : undefined;
            if (is2xx) {
              const ctor = isDefault ? `${ctorBase}Default` : `${ctorBase}S${status}`;
              let c = ctor;
              let i = 2;
              while (usedSuccessCtors.has(c)) c = `${ctor}_${i++}`;
              usedSuccessCtors.add(c);
              let payload = body ?? "unknown";
              const isInlineRecord = /^\s*\{/.test(payload);
              if (isInlineRecord) {
                const auxName = toValidTypeName(`status_${status}_body`);
                addSuccessAuxType(auxName, payload);
                payload = auxName;
              } else if (payload === "unknown") {
                const auxName = toValidTypeName(`status_${status}_body`);
                const doc = wrapBlockDoc(`TODO: ${unknownReason ?? "unknown response body"}`);
                addSuccessAuxType(auxName, `${doc ? doc + "\n" : ""}unknown`);
                payload = auxName;
              } else if (payload === "unit" && noContent) {
                const auxName = toValidTypeName(`status_${status}_body`);
                const doc = wrapBlockDoc("response has no content");
                addSuccessAuxType(auxName, `${doc ? doc + "\n" : ""}unit`);
                payload = auxName;
              }
              const variant = `${asAttr ?? ""}${c}({data: ${payload}, response: Response.t, headers: ${headerTypeName}})`;
              successVariants.push(variant);
              successPayloadTypes.push(payload);
              successStatusCodes.push(status);
            } else {
              let c = ctorBase;
              if (usedErrorCtors.has(c)) {
                c = isDefault ? `${ctorBase}Default` : `${ctorBase}S${status}`;
                let j = 2;
                while (usedErrorCtors.has(c)) c = `${c}_${j++}`;
              }
              usedErrorCtors.add(c);
              let payload = body ?? "unknown";
              const isInlineRecord = /^\s*\{/.test(payload);
              if (isInlineRecord) {
                const auxName = toValidTypeName(`status_${isDefault ? "default" : status}_error`);
                addAuxType(auxName, payload);
                payload = auxName;
              } else if (payload === "unit" && noContent) {
                const auxName = toValidTypeName(`status_${isDefault ? "default" : status}_error`);
                const doc = wrapBlockDoc("response has no content");
                addAuxType(auxName, `${doc ? doc + "\n" : ""}unit`);
                payload = auxName;
              }
              const variant = `${asAttr ?? ""}${c}({error: ${payload}, response: Response.t, headers: ${headerTypeName}})`;
              errorVariants.push(variant);
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
          // success
          if (successVariants.length === 1) {
            const fields: string[] = [
              `data: ${successPayloadTypes[0] ?? "unknown"},`,
              `response: Response.t,`,
              `${(() => {
                const code = successStatusCodes[0] ?? "200";
                const nm = toValidTypeName(`status_${code}_headers`);
                return `headers: ${nm},`;
              })()}`,
              `status: [#${successStatusCodes[0] ?? "200"}],`,
            ];
            const succBody = rawIR(`\n{\n${indentLines(fields, 2)}\n}`);
            modItems.push({ kind: "type", keyword: "type", name: "success", body: succBody });
          } else if (successVariants.length > 1) {
            const body = successVariants.map((v) => `| ${v}`).join("\n  ");
            modItems.push({ kind: "attr", code: '@tag("status")' });
            modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR(body) });
          } else {
            modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR("unknown") });
          }
          // error
          if (errorVariants.length > 0) {
            const body = errorVariants.map((v) => `| ${v}`).join("\n  ");
            modItems.push({ kind: "attr", code: '@tag("status")' });
            modItems.push({ kind: "type", keyword: "type", name: "error", body: rawIR(body) });
          } else {
            modItems.push({ kind: "type", keyword: "type", name: "error", body: rawIR("unknown") });
          }
        }

        opsItems.push({ kind: "module", name: mod, items: modItems });
      }
    }
  };

  emitForContainer(paths);
  emitForContainer(webhooks);

  // Callback operation modules under Operations
  const emitCallbacks = (
    container?: Record<string, PathItemObject | ReferenceObject> | undefined
  ) => {
    if (!container) return;
    for (const [p, item] of Object.entries(container)) {
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
                let ty = "unknown";
                if (schema) {
                  const base = toValidTypeName(`${mod}_${where}_${toValidTypeName(name)}`);
                  ty = mapSchemaToRes(schema, ctx, {
                    parentName: base,
                    collectAux: (n, b) => {
                      const { doc, code } = splitDocBlock(b);
                      paramAux.push({ name: n, body: withDoc(doc, rawIR(code)) });
                    },
                  });
                }
                const fname = toValidResFieldName(name);
                const field: FieldIR = {
                  name: fname.rendered,
                  attr: fname.attr ?? undefined,
                  typ: rawIR(ty),
                  optional: required ? undefined : "questionMark",
                };
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
                    const auxReq: Array<TypeDeclIR> = [];
                    const base = toValidTypeName(`${mod}_request_body`);
                    const mapped = mapSchemaToRes(chosenResolved.schema, ctx, {
                      parentName: base,
                      collectAux: (n, b) => {
                        const { doc, code } = splitDocBlock(b);
                        auxReq.push({ name: n, body: withDoc(doc, rawIR(code)) });
                      },
                    });
                    if (auxReq.length > 0) {
                      for (const t of auxReq) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                    }
                    if (/^\s*\{/.test(mapped)) {
                      const { doc: bdoc, code: bcode } = splitDocBlock(mapped);
                      modItems.push({ kind: "type", keyword: "type", name: base, body: withDoc(bdoc, rawIR(bcode)) });
                      bodyType = base;
                    } else {
                      bodyType = mapped;
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
              const usedSuccessCtors: Set<string> = new Set();
              const usedErrorCtors: Set<string> = new Set();
              const headerTypeDefs: Array<TypeDeclIR> = [];
              if (responses && typeof responses === "object") {
                const entries = Object.entries(responses);
                const bodies: Array<{ code: string; ty: string }> = [];
                for (const [status, respLike] of entries) {
                  const resp = isRef(respLike) ? ctx.resolve<ResponseObject>(respLike.$ref) : respLike;
                  if (!resp || typeof resp !== "object") continue;
                  let body: string | undefined;
                  let unknownReason: string | undefined;
                  let noContent: boolean = false;
                  if (resp.content && typeof resp.content === "object") {
                    const ents = Object.entries(resp.content);
                    const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                    const chosen = chosenEntry?.[1];
                    if (chosen && chosen.schema) {
                      const base = toValidTypeName(`status_${status}_body`);
                      body = mapSchemaToRes(chosen.schema, ctx, {
                        parentName: base,
                        collectAux: (n, b) => {
                          const { doc, code } = splitDocBlock(b);
                          successAuxTypes.push({ name: n, body: withDoc(doc, rawIR(code)) });
                        },
                        optionalAsOption: true,
                      });
                    } else {
                      body = "unknown";
                      unknownReason = "no schema for chosen media type";
                    }
                  } else {
                    body = "unit";
                    noContent = true;
                  }
                  const isDefault = status === "default";
                  const n = Number(status);
                  const is2xx = !isNaN(n) && n >= 200 && n < 300;
                  const refNameForCtor = isRef(respLike) ? refName(respLike.$ref) : undefined;
                  if (is2xx && body) bodies.push({ code: status, ty: body });
                  const headersVal = resp.headers;
                  const headerTypeName = toValidTypeName(`status_${status === "default" ? "default" : status}_headers`);
                  if (!headerTypeDefs.some((t) => t.name === headerTypeName)) {
                    if (headersVal && typeof headersVal === "object" && Object.keys(headersVal).length > 0) {
                      const fields: FieldIR[] = [];
                      for (const [hname, hlike] of Object.entries(headersVal)) {
                        const header: HeaderObject | undefined = isRef(hlike) ? ctx.resolve<HeaderObject>(hlike.$ref) : hlike;
                        let actual: string = "string";
                        if (header && typeof header === "object") {
                          if (header.schema) actual = mapSchemaToRes(header.schema, ctx, {});
                          else if (header.content && typeof header.content === "object") {
                            const ents = Object.entries(header.content);
                            const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                            const chosen = chosenEntry?.[1];
                            const chosenResolved = chosen && isRef(chosen) ? ctx.resolve<MediaTypeObject>(chosen.$ref) : chosen;
                            if (chosenResolved && chosenResolved.schema) actual = mapSchemaToRes(chosenResolved.schema, ctx, {});
                            else actual = "unknown";
                          }
                        }
                        const fn = toValidResFieldName(hname);
                        const field: FieldIR = {
                          name: fn.rendered,
                          attr: fn.attr ?? undefined,
                          typ: refIR("string"),
                          optional: "option",
                        };
                        if (actual !== "string") {
                          const doc = wrapBlockDoc(`actual: ${actual}`);
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
                  const asAttr = isDefault ? `@as("default") ` : !isNaN(n) ? `@as(${status}) ` : undefined;
                  if (is2xx) {
                    const ctor = isDefault ? `${ctorBase}Default` : `${ctorBase}S${status}`;
                    let c = ctor;
                    let i = 2;
                    while (usedSuccessCtors.has(c)) c = `${ctor}_${i++}`;
                    usedSuccessCtors.add(c);
                    let payload = body ?? "unknown";
                    const isInlineRecord = /^\s*\{/.test(payload);
                    if (isInlineRecord) {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      successAuxTypes.push({ name: auxName, body: rawIR(payload) });
                      payload = auxName;
                    } else if (payload === "unknown") {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      const doc = wrapBlockDoc(`TODO: ${unknownReason ?? "unknown response body"}`);
                      successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unknown")) });
                      payload = auxName;
                    } else if (payload === "unit" && noContent) {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      const doc = wrapBlockDoc("response has no content");
                      successAuxTypes.push({ name: auxName, body: withDoc(doc, rawIR("unit")) });
                      payload = auxName;
                    }
                    const pay = rawIR(`{data: ${payload}, response: Response.t, headers: ${headerTypeName}}`);
                    successVariants.push({ label: c, payload: pay, attr: asAttr });
                    successPayloadTypes.push(payload);
                    successStatusCodes.push(status);
                  } else {
                    let c = ctorBase;
                    if (usedErrorCtors.has(c)) {
                      c = isDefault ? `${ctorBase}Default` : `${ctorBase}S${status}`;
                      let j = 2;
                      while (usedErrorCtors.has(c)) c = `${c}_${j++}`;
                    }
                    usedErrorCtors.add(c);
                    let payload = body ?? "unknown";
                    const isInlineRecord = /^\s*\{/.test(payload);
                    if (isInlineRecord) {
                      const auxName = toValidTypeName(`status_${isDefault ? "default" : status}_error`);
                      auxTypes.push({ name: auxName, body: rawIR(payload) });
                      payload = auxName;
                    }
                    const pay = rawIR(`{error: ${payload}, response: Response.t, headers: ${headerTypeName}}`);
                    errorVariants.push({ label: c, payload: pay, attr: asAttr });
                  }
                }

                if (headerTypeDefs.length > 0) {
                  for (const t of headerTypeDefs) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
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
                if (successAuxTypes.length > 0) {
                  for (const t of successAuxTypes) modItems.push({ kind: "type", keyword: "type", name: t.name, body: t.body });
                }
                if (successVariants.length >= 1) {
                  modItems.push({ kind: "attr", code: '@tag("status")' });
                  const cases = successVariants.map((v) => ({ label: `#${v.label.startsWith("#") ? v.label.slice(1) : v.label}`.slice(1), payload: v.payload, attr: v.attr }));
                  // Above mapping mistakenly adds '#'—but constructors are not prefixed with '#'. Keep label as-is.
                  const cases2 = successVariants.map((v) => ({ label: v.label, payload: v.payload, attr: v.attr }));
                  modItems.push({ kind: "type", keyword: "type", name: "success", body: adtIR(cases2) });
                } else {
                  modItems.push({ kind: "type", keyword: "type", name: "success", body: rawIR("unknown") });
                }
                if (errorVariants.length > 0) {
                  modItems.push({ kind: "attr", code: '@tag("status")' });
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
