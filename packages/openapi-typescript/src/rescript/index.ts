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
      const tmp = {
        ...s,
        type: others[0],
      } as SchemaObject;
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
  if (isObjectSchema(s)) {
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
      let inner = mapSchemaToRes(ap as SchemaLike, ctx, {
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

    const tryInlineObject = (v: unknown): SchemaObject | undefined => {
      if (!v || typeof v !== "object") return undefined;
      let node: SchemaObject | undefined;
      if (isRef(v)) node = ctx.resolve<SchemaObject>(v.$ref);
      else node = v as SchemaObject;
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

    const isAnnotationOnly = (s: any): boolean => {
      if (!s || typeof s !== "object") return false;
      const keys = Object.keys(s);
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

    const isArraySchema = (v: unknown): SchemaObject | undefined => {
      if (!v || typeof v !== "object") return undefined;
      const node = isRef(v)
        ? ctx.resolve<SchemaObject>(v.$ref)
        : (v as SchemaObject);
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

    const isScalarSchema = (v: unknown): v is SchemaObject => {
      if (!v || typeof v !== "object") return false;
      let node: SchemaObject | undefined;
      if (isRef(v)) node = ctx.resolve<SchemaObject>(v.$ref);
      else node = v as SchemaObject;
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

function renderComponentsSchemas(
  components: ComponentsObject | undefined,
  ctx: RSContext
): string[] {
  const lines: string[] = [];
  lines.push("module Components = {");
  lines.push(indentLines("module Schemas = {", 2));

  const schemas = components?.schemas ?? {};
  const entries = getEntries(schemas, {
    alphabetize: ctx.alphabetize,
    excludeDeprecated: ctx.excludeDeprecated,
  });
  if (entries.length > 0) {
    const decls: string[] = [];
    entries.forEach(([name, schema], idx) => {
      const typeName = toValidTypeName(name);
      const aux: Array<{ name: string; body: string }> = [];
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
      let body = mapSchemaToRes(schema, ctx, {
        parentName: typeName,
        collectAux: (n, b) => aux.push({ name: n, body: b }),
        optionalAsOption: true,
      });
      // Final guard: ensure no inline record is left inside wrappers at the top level
      body = hoistInlineRecordsInWrappers(
        body,
        (n, b) => aux.push({ name: n, body: b }),
        typeName
      );
      if (body.trim() === "unknown") {
        const extra = wrapBlockDoc(
          "TODO: unsupported or ambiguous schema; fell back to unknown"
        );
        if (extra)
          topDoc = topDoc
            ? `${topDoc}\n${extra.replace(/^\/\*\*|\*\/$/g, "").trim()}`
            : extra.replace(/^\/\*\*|\*\/$/g, "").trim();
      }
      const doc = wrapBlockDoc(topDoc);
      const kw = idx === 0 ? "type rec" : "and";
      const decl = `${doc ? doc + "\n" : ""}${kw} ${typeName} = ${body}`;
      decls.push(decl);
      if (aux.length > 0) {
        const seen = new Set<string>();
        for (const t of aux) {
          if (seen.has(t.name)) continue;
          // If body starts with a doc block, lift it before the type declaration
          if (t.body.trimStart().startsWith("/**")) {
            const idx = t.body.indexOf("*/");
            if (idx >= 0) {
              const doc = t.body.slice(0, idx + 2);
              const rest = t.body.slice(idx + 2).trimStart();
              decls.push(`${doc}\nand ${t.name} = ${rest}`);
              seen.add(t.name);
              continue;
            }
          }
          decls.push(`and ${t.name} = ${t.body}`);
          seen.add(t.name);
        }
      }
    });
    lines.push(indentLines(decls.join("\n"), 4));
  }

  lines.push(indentLines("}", 2));
  // Headers aggregator submodule
  lines.push(indentLines("module Headers = {", 2));
  const hdrs = components?.headers ?? {};
  const hdrEntries = Object.entries(hdrs);
  if (hdrEntries.length > 0) {
    const fields: string[] = [];
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
      const field = `${fn.attr ?? ""}${fn.rendered}: option<string>,`;
      if (actual !== "string") {
        const doc = wrapBlockDoc(`actual: ${actual}`);
        if (doc) fields.push(doc);
      }
      fields.push(field);
    }
    lines.push(
      indentLines(`type response = \n{\n${indentLines(fields, 2)}\n}`, 4)
    );
  } else {
    lines.push(indentLines(`type response = emptyObject`, 4));
  }
  lines.push(indentLines("}", 2));
  lines.push("}");
  return lines;
}

export function emitReScript(schema: OpenAPI3, ctx: RSContext): string {
  const out: string[] = [];
  // Use the same header format; it’s valid ReScript doc comment
  out.push(COMMENT_HEADER.trimEnd());
  // Silence selected warnings from generated code
  out.push('@@warning("-30")');
  // Bring OpenAPIFetch helpers (emptyObject, Wrapped, etc.) into scope
  out.push("open OpenAPIFetch\n");

  // Start with Components.Schemas only (Phase 0)
  out.push(...renderComponentsSchemas(schema.components, ctx));

  // Minimal Operations emission (modules only with placeholders)
  out.push(...renderOperations(schema.paths, schema.webhooks, ctx));

  // Paths & Client types
  const { lines: pathLines, hasClient } = renderPaths(schema.paths, ctx);
  out.push(...pathLines);
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
    if (clientDoc) out.push("", clientDoc);
    out.push(
      '@module("openapi-fetch")',
      'external createClient: createClientOptions => Client.clientContainer<client> = "createClient"',
      "",
      "let createClient = options => createFetchClient(createClient(options))",
      ""
    );
  }

  // Webhooks types
  const { lines: webhookLines } = renderWebhooks(schema.webhooks, ctx);
  out.push(...webhookLines);

  // Callbacks types
  const { lines: callbackLines } = renderCallbacks(schema.paths, ctx);
  out.push(...callbackLines);

  return out.join("\n") + "\n";
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

function renderOperations(
  paths: PathsObject | undefined,
  webhooks: OpenAPI3["webhooks"] | undefined,
  ctx: RSContext
): string[] {
  const lines: string[] = [];
  lines.push("module Operations = {");
  // Bring component schema types into scope for operation payloads
  lines.push(indentLines("open Components.Schemas", 2));

  function emitForContainer(
    container?: Record<string, PathItemObject | ReferenceObject> | undefined
  ) {
    if (!container) return;
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
    for (const [p, item] of Object.entries(container)) {
      for (const m of METHODS) {
        const op = isRef(item) ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        let opName: string | undefined = undefined;
        if (opId && opId.length > 0) opName = opId;
        else opName = `${String(p)}_${String(m)}`;
        const mod = toValidModuleName(opName);
        lines.push(indentLines(`module ${mod} = {`, 2));
        // Security requirements doc (if any)
        const secReq = op.security as
          | Array<Record<string, string[]>>
          | undefined;
        if (Array.isArray(secReq) && secReq.length > 0) {
          const parts: string[] = [];
          for (const req of secReq) {
            for (const [scheme, scopes] of Object.entries(req)) {
              const list = scopes.length > 0 ? ` [${scopes.join(", ")}]` : "";
              parts.push(`${scheme}${list}`);
            }
          }
          const doc = wrapBlockDoc(
            parts.length > 0 ? `security: ${parts.join("; ")}` : undefined
          );
          if (doc) lines.push(indentLines(doc, 4));
        }
        // PARAMETERS: collect from path-level + op-level
        const allParams: Array<
          import("../types.js").ParameterObject | ReferenceObject
        > = [];
        const pathParams = isRef(item) ? undefined : item.parameters;
        if (Array.isArray(pathParams)) allParams.push(...pathParams);
        const opParams = op.parameters as
          | (import("../types.js").ParameterObject | ReferenceObject)[]
          | undefined;
        if (Array.isArray(opParams)) allParams.push(...opParams);

        type GroupKey = "query" | "header" | "path" | "cookie";
        const groups: Record<GroupKey, string[]> = {
          query: [],
          header: [],
          path: [],
          cookie: [],
        };
        const paramAux: Array<{ name: string; body: string }> = [];
        const present: Set<GroupKey> = new Set();
        for (const p of allParams) {
          const param = isRef(p)
            ? ctx.resolve<import("../types.js").ParameterObject>(p.$ref)
            : p;
          if (!param) continue;
          const where = param.in;
          const name = param.name;
          if (!where || !name) continue;
          const required = !!param.required;
          const schema = param.schema;
          let ty = "unknown";
          if (schema) {
            const base = toValidTypeName(
              `${mod}_${where}_${toValidTypeName(name)}`
            );
            ty = mapSchemaToRes(schema, ctx, {
              parentName: base,
              collectAux: (n, b) => paramAux.push({ name: n, body: b }),
            });
          }
          const fname = toValidResFieldName(name);
          const sep = required ? ": " : "?: ";
          const pdoc = wrapBlockDoc(param.description);
          if (pdoc) groups[where].push(pdoc);
          groups[where].push(
            `${fname.attr ?? ""}${fname.rendered}${sep}${ty},`
          );
          present.add(where);
        }

        const paramTypeDecls: string[] = [];
        const fieldOrder: GroupKey[] = ["query", "header", "path", "cookie"];
        if (paramAux.length > 0) {
          const seenParamAux = new Set<string>();
          for (const t of paramAux) {
            if (seenParamAux.has(t.name)) continue;
            const trimmed = t.body.trimStart();
            if (trimmed.startsWith("/**")) {
              const idx = trimmed.indexOf("*/");
              if (idx >= 0) {
                const doc = trimmed.slice(0, idx + 2);
                const rest = trimmed.slice(idx + 2).trimStart();
                lines.push(indentLines(doc, 4));
                lines.push(indentLines(`type ${t.name} = ${rest}`, 4));
                seenParamAux.add(t.name);
                continue;
              }
            }
            lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
            seenParamAux.add(t.name);
          }
        }
        for (const k of fieldOrder) {
          if (!present.has(k)) continue;
          const body = groups[k];
          const typeBody = `\n{\n${indentLines(body, 2)}\n}`;
          lines.push(indentLines(`type ${k} = ${typeBody}`, 4));
        }
        if (present.size > 0) {
          const paramsFields: string[] = [];
          for (const k of fieldOrder) {
            if (!present.has(k)) continue;
            const target = toValidResFieldName(k);
            paramsFields.push(`${target.attr ?? ""}${target.rendered}?: ${k},`);
          }
          lines.push(
            indentLines(
              `type params = \n{\n${indentLines(paramsFields, 2)}\n}`,
              4
            )
          );
        }

        // REQUEST BODY: prefer application/json schema
        let bodyType: string | undefined = undefined;
        const rb = op.requestBody;
        if (rb) {
          const req = isRef(rb) ? ctx.resolve<RequestBodyObject>(rb.$ref) : rb;
          const content = req ? req.content : undefined;
          if (content) {
            const entries = Object.entries(content);
            let chosen: MediaTypeObject | ReferenceObject | undefined;
            for (const [k, v] of entries) {
              if (k === "application/json") {
                chosen = v;
                break;
              }
            }
            if (!chosen && entries.length === 1) chosen = entries[0]![1];
            const chosenResolved =
              chosen && isRef(chosen)
                ? ctx.resolve<MediaTypeObject>(chosen.$ref)
                : chosen;
            if (chosenResolved && chosenResolved.schema) {
              // Pass a parentName + collector so inline union members get hoisted to aux types
              const aux: Array<{ name: string; body: string }> = [];
              const base = toValidTypeName(`${mod}_request_body`);
              const mapped = mapSchemaToRes(chosenResolved.schema, ctx, {
                parentName: base,
                collectAux: (n, b) => aux.push({ name: n, body: b }),
              });
              if (aux.length > 0) {
                const seenReqAux = new Set<string>();
                for (const t of aux) {
                  if (seenReqAux.has(t.name)) continue;
                  const trimmed = t.body.trimStart();
                  if (trimmed.startsWith("/**")) {
                    const idx = trimmed.indexOf("*/");
                    if (idx >= 0) {
                      const doc = trimmed.slice(0, idx + 2);
                      const rest = trimmed.slice(idx + 2).trimStart();
                      lines.push(indentLines(doc, 4));
                      lines.push(indentLines(`type ${t.name} = ${rest}`, 4));
                      seenReqAux.add(t.name);
                      continue;
                    }
                  }
                  lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
                  seenReqAux.add(t.name);
                }
              }
              // Never inline record types directly in field positions; use a named aux type
              if (/^\s*\{/.test(mapped)) {
                const trimmed = mapped.trimStart();
                if (trimmed.startsWith("/**")) {
                  const idx = trimmed.indexOf("*/");
                  if (idx >= 0) {
                    const doc = trimmed.slice(0, idx + 2);
                    const rest = trimmed.slice(idx + 2).trimStart();
                    lines.push(indentLines(doc, 4));
                    lines.push(indentLines(`type ${base} = ${rest}`, 4));
                  } else {
                    lines.push(indentLines(`type ${base} = ${mapped}`, 4));
                  }
                } else {
                  lines.push(indentLines(`type ${base} = ${mapped}`, 4));
                }
                bodyType = base;
              } else {
                bodyType = mapped;
              }
            } else {
              // if we can't detect a schema, default to JSON.t to signal presence of a body
              bodyType = "JSON.t";
            }
          }
        }

        // Minimal placeholders for now; parameters wrapper when needed
        const parametersFields: string[] = [];
        if (present.size > 0) parametersFields.push("params?: params,");
        if (bodyType) parametersFields.push(`body?: ${bodyType},`);
        if (parametersFields.length > 0) {
          lines.push(
            indentLines(
              `type parameters = \n{\n${indentLines(parametersFields, 2)}\n}`,
              4
            )
          );
        } else {
          lines.push(indentLines(`type parameters = emptyObject`, 4));
        }
        // RESPONSES: status-tagged variants for multi-2xx and non-2xx/default
        const responses = op.responses;
        let singleSuccess: { code: string; ty: string } | undefined;
        const successVariants: string[] = [];
        const successPayloadTypes: string[] = [];
        const successStatusCodes: string[] = [];
        const errorVariants: string[] = [];
        const usedSuccessCtors: Set<string> = new Set();
        const usedErrorCtors: Set<string> = new Set();
        const auxTypes: { name: string; body: string }[] = [];
        const addAuxType = (name: string, body: string) => {
          if (!auxTypes.some((t) => t.name === name))
            auxTypes.push({ name, body });
        };
        const successAuxTypes: { name: string; body: string }[] = [];
        const addSuccessAuxType = (name: string, body: string) => {
          if (!successAuxTypes.some((t) => t.name === name))
            successAuxTypes.push({ name, body });
        };
        const headerTypeDefs: { name: string; body: string }[] = [];
        const emitTypeWithDoc = (
          indent: number,
          name: string,
          body: string
        ) => {
          const trimmed = body.trimStart();
          if (trimmed.startsWith("/**")) {
            const idx = trimmed.indexOf("*/");
            if (idx >= 0) {
              const doc = trimmed.slice(0, idx + 2);
              const rest = trimmed.slice(idx + 2).trimStart();
              lines.push(indentLines(doc, indent));
              lines.push(indentLines(`type ${name} = ${rest}`, indent));
              return;
            }
          }
          lines.push(indentLines(`type ${name} = ${body}`, indent));
        };

        if (responses && typeof responses === "object") {
          // Collect success bodies for flattening case as well
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

            const resolved = isRef(respLike)
              ? ctx.resolve<ResponseObject>(respLike.$ref)
              : respLike;
            const content =
              resolved && typeof resolved === "object"
                ? resolved.content
                : undefined;
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
                // For response bodies, pass a parentName + collector to hoist inline union members
                const base = toValidTypeName(`status_${status}_body`);
                const auxLocal: Array<{ name: string; body: string }> = [];
                body = mapSchemaToRes(chosen.schema, ctx, {
                  parentName: base,
                  collectAux: (n, b) => addSuccessAuxType(n, b),
                  optionalAsOption: true,
                });
              } else {
                // No schema for chosen media type
                body = "unknown";
                unknownReason = "no schema for chosen media type";
              }
            } else {
              // No content for this response status (e.g., 204) or unspecified
              body = "unit";
              noContent = true;
            }

            if (is2xx) bodies.push({ code: status, ty: body ?? "unknown" });

            // Build per-status headers type
            const headersVal =
              resolved && typeof resolved === "object"
                ? resolved.headers
                : undefined;
            const headerTypeName = toValidTypeName(
              `status_${isDefault ? "default" : status}_headers`
            );
            if (!headerTypeDefs.some((t) => t.name === headerTypeName)) {
              let headerBody: string;
              if (
                headersVal &&
                typeof headersVal === "object" &&
                Object.keys(headersVal).length > 0
              ) {
                const fields: string[] = [];
                for (const [hname, hlike] of Object.entries(headersVal)) {
                  const header: HeaderObject | undefined = isRef(hlike)
                    ? ctx.resolve<HeaderObject>(hlike.$ref)
                    : hlike;
                  let actual: string = "string";
                  if (header && typeof header === "object") {
                    if (header.schema) {
                      actual = mapSchemaToRes(header.schema, ctx, {});
                    } else if (
                      header.content &&
                      typeof header.content === "object"
                    ) {
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
                  const fn = toValidResFieldName(hname);
                  if (actual !== "string") {
                    const doc = wrapBlockDoc(`actual: ${actual}`);
                    if (doc) fields.push(doc);
                  }
                  fields.push(
                    `${fn.attr ?? ""}${fn.rendered}: option<string>,`
                  );
                }
                headerBody = `\n{\n${indentLines(fields, 2)}\n}`;
              } else {
                headerBody = `emptyObject`;
              }
              headerTypeDefs.push({ name: headerTypeName, body: headerBody });
            }

            // Constructor naming similar to src/main.ts
            const ctorBase = refNameForCtor ?? "Data";
            const asAttr = isDefault
              ? `@as("default") `
              : !isNaN(n)
                ? `@as(${status}) `
                : undefined;

            if (is2xx) {
              // success variants accumulate for multi-2xx
              const ctor = isDefault
                ? `${ctorBase}Default`
                : `${ctorBase}S${status}`;
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
                const doc = wrapBlockDoc(
                  `TODO: ${unknownReason ?? "unknown response body"}`
                );
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
              // error variants: tagged by status/default, payload under `error`
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
                const auxName = toValidTypeName(
                  `status_${isDefault ? "default" : status}_error`
                );
                addAuxType(auxName, payload);
                payload = auxName;
              } else if (payload === "unknown") {
                const auxName = toValidTypeName(
                  `status_${isDefault ? "default" : status}_error`
                );
                const doc = wrapBlockDoc(
                  `TODO: ${unknownReason ?? "unknown error body"}`
                );
                addAuxType(auxName, `${doc ? doc + "\n" : ""}unknown`);
                payload = auxName;
              } else if (payload === "unit" && noContent) {
                const auxName = toValidTypeName(
                  `status_${isDefault ? "default" : status}_error`
                );
                const doc = wrapBlockDoc("response has no content");
                addAuxType(auxName, `${doc ? doc + "\n" : ""}unit`);
                payload = auxName;
              }
              const variant = `${asAttr ?? ""}${c}({error: ${payload}, response: Response.t, headers: ${headerTypeName}})`;
              errorVariants.push(variant);
            }
          }
          // we no longer flatten single-success; always emit status-tagged variants
        }

        // Emit per-status header types
        if (headerTypeDefs.length > 0) {
          const seenHdr = new Set<string>();
          for (const t of headerTypeDefs) {
            if (seenHdr.has(t.name)) continue;
            lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
            seenHdr.add(t.name);
          }
        }

        // Emit aux types needed for success payloads first (so errors can reference them)
        if (successAuxTypes.length > 0) {
          const seenSucc = new Set<string>();
          for (const t of successAuxTypes) {
            if (seenSucc.has(t.name)) continue;
            emitTypeWithDoc(4, t.name, t.body);
            seenSucc.add(t.name);
          }
        }

        // Emit any aux types derived from inline record payloads (errors)
        if (auxTypes.length > 0) {
          for (const t of auxTypes) emitTypeWithDoc(4, t.name, t.body);
        }

        // per-operation status alias (success 2xx codes)
        if (successStatusCodes.length > 0) {
          const uniq = Array.from(new Set(successStatusCodes));
          const sorted = uniq.sort((a, b) => Number(a) - Number(b));
          const pv = sorted.map((s) => `#${s}`).join(" | ");
          lines.push(indentLines(`type status = [${pv}]`, 4));
        }
        if (successVariants.length === 1) {
          // Flatten single-success into a record for ergonomics/parity
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
          lines.push(
            indentLines(`type success = \n{\n${indentLines(fields, 2)}\n}`, 4)
          );
        } else if (successVariants.length > 1) {
          const body = successVariants.map((v) => `| ${v}`).join("\n  ");
          lines.push(
            indentLines(`@tag("status")\ntype success =\n  ${body}`, 4)
          );
        } else {
          lines.push(indentLines(`type success = unknown`, 4));
        }

        if (errorVariants.length > 0) {
          const body = errorVariants.map((v) => `| ${v}`).join("\n  ");
          lines.push(indentLines(`@tag("status")\ntype error =\n  ${body}`, 4));
        } else {
          lines.push(indentLines(`type error = unknown`, 4));
        }
        lines.push(indentLines(`}`, 2));
      }
    }
  }

  emitForContainer(paths);
  emitForContainer(webhooks);

  // Emit callback operations (nested under path operations)
  const emitCallbacks = (
    container?: Record<string, PathItemObject | ReferenceObject> | undefined
  ) => {
    if (!container || typeof container !== "object") return;
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
    for (const [p, item] of Object.entries(container)) {
      if (!item || typeof item !== "object") continue;
      for (const m of METHODS) {
        const op = "$ref" in item ? undefined : resolveOperation(item[m], ctx);
        if (!op) continue;
        const baseName =
          op.operationId &&
          typeof op.operationId === "string" &&
          op.operationId.length > 0
            ? op.operationId
            : `${String(p)}_${String(m)}`;
        const callbacks = op.callbacks as
          | Record<
              string,
              import("../types.js").CallbackObject | ReferenceObject
            >
          | undefined;
        if (!callbacks) continue;
        for (const [cbName, cbVal] of Object.entries(callbacks)) {
          const cbResolved =
            cbVal && isRef(cbVal)
              ? ctx.resolve<import("../types.js").CallbackObject>(cbVal.$ref)
              : cbVal;
          if (!cbResolved) continue;
          for (const [, cbPathItemLike] of Object.entries(cbResolved)) {
            const cbItem =
              cbPathItemLike && isRef(cbPathItemLike)
                ? ctx.resolve<PathItemObject>(cbPathItemLike.$ref)
                : cbPathItemLike;
            if (!cbItem || typeof cbItem !== "object") continue;
            for (const m2 of METHODS) {
              const cbOp = resolveOperation(cbItem[m2], ctx);
              if (!cbOp) continue;
              const mod = toValidModuleName(`${baseName}_${cbName}_${m2}`);
              lines.push(indentLines(`module ${mod} = {`, 2));

              // PARAMETERS for callback op: collect from callback path-level + op-level
              const allParams: Array<unknown> = [];
              const pathParams = cbItem.parameters as
                | (import("../types.js").ParameterObject | ReferenceObject)[]
                | undefined;
              if (Array.isArray(pathParams)) allParams.push(...pathParams);
              const opParams = cbOp.parameters as
                | (import("../types.js").ParameterObject | ReferenceObject)[]
                | undefined;
              if (Array.isArray(opParams)) allParams.push(...opParams);

              type GroupKey = "query" | "header" | "path" | "cookie";
              const groups: Record<GroupKey, string[]> = {
                query: [],
                header: [],
                path: [],
                cookie: [],
              };
              const paramAux: Array<{ name: string; body: string }> = [];
              const present: Set<GroupKey> = new Set();
              for (const p of allParams) {
                const paramLike = p as
                  | import("../types.js").ParameterObject
                  | ReferenceObject;
                const param = isRef(paramLike)
                  ? ctx.resolve<import("../types.js").ParameterObject>(
                      paramLike.$ref
                    )
                  : paramLike;
                if (!param || typeof param !== "object") continue;
                const where = param.in;
                const name = param.name;
                if (!where || !name) continue;
                const required = !!param.required;
                const schema = param.schema;
                let ty = "unknown";
                if (schema) {
                  const base = toValidTypeName(
                    `${mod}_${where}_${toValidTypeName(name)}`
                  );
                  ty = mapSchemaToRes(schema, ctx, {
                    parentName: base,
                    collectAux: (n, b) => paramAux.push({ name: n, body: b }),
                  });
                }
                const fname = toValidResFieldName(name);
                const sep = required ? ": " : "?: ";
                groups[where].push(
                  `${fname.attr ?? ""}${fname.rendered}${sep}${ty},`
                );
                present.add(where);
              }

              const fieldOrder: GroupKey[] = [
                "query",
                "header",
                "path",
                "cookie",
              ];
              if (paramAux.length > 0) {
                for (const t of paramAux) {
                  const trimmed = t.body.trimStart();
                  if (trimmed.startsWith("/**")) {
                    const idx = trimmed.indexOf("*/");
                    if (idx >= 0) {
                      const doc = trimmed.slice(0, idx + 2);
                      const rest = trimmed.slice(idx + 2).trimStart();
                      lines.push(indentLines(doc, 4));
                      lines.push(indentLines(`type ${t.name} = ${rest}`, 4));
                      continue;
                    }
                  }
                  lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
                }
              }
              for (const k of fieldOrder) {
                if (!present.has(k)) continue;
                const body = groups[k];
                const typeBody = `\n{\n${indentLines(body, 2)}\n}`;
                lines.push(indentLines(`type ${k} = ${typeBody}`, 4));
              }
              if (present.size > 0) {
                const paramsFields: string[] = [];
                for (const k of fieldOrder) {
                  if (!present.has(k)) continue;
                  const target = toValidResFieldName(k);
                  paramsFields.push(
                    `${target.attr ?? ""}${target.rendered}?: ${k},`
                  );
                }
                lines.push(
                  indentLines(
                    `type params = \n{\n${indentLines(paramsFields, 2)}\n}`,
                    4
                  )
                );
              }

              // REQUEST BODY
              let bodyType: string | undefined = undefined;
              const rb = cbOp.requestBody;
              if (rb) {
                const req = isRef(rb)
                  ? ctx.resolve<RequestBodyObject>(rb.$ref)
                  : rb;
                const content =
                  req && req.content && typeof req.content === "object"
                    ? req.content
                    : undefined;
                if (content) {
                  const entries = Object.entries(content);
                  let chosen: MediaTypeObject | ReferenceObject | undefined =
                    undefined;
                  for (const [k, v] of entries) {
                    if (k === "application/json") {
                      chosen = v;
                      break;
                    }
                  }
                  if (!chosen && entries.length === 1) chosen = entries[0]![1];
                  const chosenResolved =
                    chosen && isRef(chosen)
                      ? ctx.resolve<MediaTypeObject>(chosen.$ref)
                      : chosen;
                  if (chosenResolved && chosenResolved.schema) {
                    // Hoist inline union members for callback request bodies
                    const auxReq: Array<{ name: string; body: string }> = [];
                    const base = toValidTypeName(`${mod}_request_body`);
                    const mapped = mapSchemaToRes(chosenResolved.schema, ctx, {
                      parentName: base,
                      collectAux: (n, b) => auxReq.push({ name: n, body: b }),
                    });
                    if (auxReq.length > 0) {
                      for (const t of auxReq) {
                        const trimmed = t.body.trimStart();
                        if (trimmed.startsWith("/**")) {
                          const idx = trimmed.indexOf("*/");
                          if (idx >= 0) {
                            const doc = trimmed.slice(0, idx + 2);
                            const rest = trimmed.slice(idx + 2).trimStart();
                            lines.push(indentLines(doc, 4));
                            lines.push(
                              indentLines(`type ${t.name} = ${rest}`, 4)
                            );
                            continue;
                          }
                        }
                        lines.push(
                          indentLines(`type ${t.name} = ${t.body}`, 4)
                        );
                      }
                    }
                    if (/^\s*\{/.test(mapped)) {
                      const trimmed = mapped.trimStart();
                      if (trimmed.startsWith("/**")) {
                        const idx = trimmed.indexOf("*/");
                        if (idx >= 0) {
                          const doc = trimmed.slice(0, idx + 2);
                          const rest = trimmed.slice(idx + 2).trimStart();
                          lines.push(indentLines(doc, 4));
                          lines.push(indentLines(`type ${base} = ${rest}`, 4));
                        } else {
                          lines.push(
                            indentLines(`type ${base} = ${mapped}`, 4)
                          );
                        }
                      } else {
                        lines.push(indentLines(`type ${base} = ${mapped}`, 4));
                      }
                      bodyType = base;
                    } else {
                      bodyType = mapped;
                    }
                  } else {
                    bodyType = "JSON.t";
                  }
                }
              }

              const parametersFields: string[] = [];
              if (present.size > 0) parametersFields.push("params?: params,");
              if (bodyType) parametersFields.push(`body?: ${bodyType},`);
              if (parametersFields.length > 0) {
                lines.push(
                  indentLines(
                    `type parameters = \n{\n${indentLines(parametersFields, 2)}\n}`,
                    4
                  )
                );
              } else {
                lines.push(indentLines(`type parameters = emptyObject`, 4));
              }

              // RESPONSES
              const responses = cbOp.responses;
              const successVariants: string[] = [];
              const successPayloadTypes: string[] = [];
              const successStatusCodes: string[] = [];
              const errorVariants: string[] = [];
              const auxTypes: Array<{ name: string; body: string }> = [];
              const successAuxTypes: Array<{ name: string; body: string }> = [];
              const addAuxType = (name: string, body: string) =>
                auxTypes.push({ name, body });
              const addSuccessAuxType = (name: string, body: string) =>
                successAuxTypes.push({ name, body });
              const usedSuccessCtors = new Set<string>();
              const usedErrorCtors = new Set<string>();
              const headerTypeDefs: Array<{ name: string; body: string }> = [];
              if (responses && typeof responses === "object") {
                const entries = Object.entries(responses);
                const bodies: Array<{ code: string; ty: string }> = [];
                for (const [status, respLike] of entries) {
                  const resp = isRef(respLike)
                    ? ctx.resolve<ResponseObject>(respLike.$ref)
                    : respLike;
                  if (!resp || typeof resp !== "object") continue;
                  let body: string | undefined;
                  let unknownReason: string | undefined;
                  let noContent: boolean = false;
                  if (resp.content && typeof resp.content === "object") {
                    const ents = Object.entries(resp.content);
                    const chosenEntry =
                      ents.find(([k]) => k === "application/json") ?? ents[0];
                    const chosen = chosenEntry?.[1];
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
                  const isDefault = status === "default";
                  const n = Number(status);
                  const is2xx = !isNaN(n) && n >= 200 && n < 300;
                  const refNameForCtor = isRef(respLike)
                    ? refName(respLike.$ref)
                    : undefined;
                  if (is2xx && body) bodies.push({ code: status, ty: body });

                  // Build per-status headers type
                  const headersVal = resp.headers;
                  const headerTypeName = toValidTypeName(
                    `status_${status === "default" ? "default" : status}_headers`
                  );
                  if (!headerTypeDefs.some((t) => t.name === headerTypeName)) {
                    let headerBody: string;
                    if (
                      headersVal &&
                      typeof headersVal === "object" &&
                      Object.keys(headersVal).length > 0
                    ) {
                      const fields: string[] = [];
                      for (const [hname, hlike] of Object.entries(headersVal)) {
                        const header: HeaderObject | undefined = isRef(hlike)
                          ? ctx.resolve<HeaderObject>(hlike.$ref)
                          : hlike;
                        let actual: string = "string";
                        if (header && typeof header === "object") {
                          if (header.schema)
                            actual = mapSchemaToRes(header.schema, ctx, {});
                          else if (
                            header.content &&
                            typeof header.content === "object"
                          ) {
                            const ents = Object.entries(header.content);
                            const chosenEntry =
                              ents.find(([k]) => k === "application/json") ??
                              ents[0];
                            const chosen = chosenEntry?.[1];
                            const chosenResolved =
                              chosen && isRef(chosen)
                                ? ctx.resolve<MediaTypeObject>(chosen.$ref)
                                : chosen;
                            if (chosenResolved && chosenResolved.schema)
                              actual = mapSchemaToRes(
                                chosenResolved.schema,
                                ctx,
                                {}
                              );
                            else actual = "unknown";
                          }
                        }
                        const fn = toValidResFieldName(hname);
                        if (actual !== "string") {
                          const doc = wrapBlockDoc(`actual: ${actual}`);
                          if (doc) fields.push(doc);
                        }
                        fields.push(
                          `${fn.attr ?? ""}${fn.rendered}: option<string>,`
                        );
                      }
                      headerBody = `\n{\n${indentLines(fields, 2)}\n}`;
                    } else {
                      headerBody = `emptyObject`;
                    }
                    headerTypeDefs.push({
                      name: headerTypeName,
                      body: headerBody,
                    });
                  }

                  if (is2xx) {
                    const ctorBase = refNameForCtor ?? "Data";
                    const asAttr = isDefault
                      ? `@as("default") `
                      : !isNaN(n)
                        ? `@as(${status}) `
                        : undefined;
                    const ctor = isDefault
                      ? `${ctorBase}Default`
                      : `${ctorBase}S${status}`;
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
                      const doc = wrapBlockDoc(
                        `TODO: ${unknownReason ?? "unknown response body"}`
                      );
                      addSuccessAuxType(
                        auxName,
                        `${doc ? doc + "\n" : ""}unknown`
                      );
                      payload = auxName;
                    } else if (payload === "unit" && noContent) {
                      const auxName = toValidTypeName(`status_${status}_body`);
                      const doc = wrapBlockDoc("response has no content");
                      addSuccessAuxType(
                        auxName,
                        `${doc ? doc + "\n" : ""}unit`
                      );
                      payload = auxName;
                    }
                    const variant = `${asAttr ?? ""}${c}({data: ${payload}, response: Response.t, headers: ${headerTypeName}})`;
                    successVariants.push(variant);
                    successPayloadTypes.push(payload);
                    successStatusCodes.push(status);
                  } else {
                    let c = refNameForCtor ?? "Error";
                    if (usedErrorCtors.has(c)) {
                      c = isDefault ? `${c}Default` : `${c}S${status}`;
                      let j = 2;
                      while (usedErrorCtors.has(c)) c = `${c}_${j++}`;
                    }
                    usedErrorCtors.add(c);
                    let payload = body ?? "unknown";
                    const isInlineRecord = /^\s*\{/.test(payload);
                    if (isInlineRecord) {
                      const auxName = toValidTypeName(
                        `status_${isDefault ? "default" : status}_error`
                      );
                      addAuxType(auxName, payload);
                      payload = auxName;
                    } else if (payload === "unknown") {
                      const auxName = toValidTypeName(
                        `status_${isDefault ? "default" : status}_error`
                      );
                      const doc = wrapBlockDoc(
                        `TODO: ${unknownReason ?? "unknown error body"}`
                      );
                      addAuxType(auxName, `${doc ? doc + "\n" : ""}unknown`);
                      payload = auxName;
                    } else if (payload === "unit" && noContent) {
                      const auxName = toValidTypeName(
                        `status_${isDefault ? "default" : status}_error`
                      );
                      const doc = wrapBlockDoc("response has no content");
                      addAuxType(auxName, `${doc ? doc + "\n" : ""}unit`);
                      payload = auxName;
                    }
                    const asAttr = isDefault
                      ? `@as("default") `
                      : !isNaN(Number(status))
                        ? `@as(${status}) `
                        : undefined;
                    const variant = `${asAttr ?? ""}${c}({error: ${payload}, response: Response.t, headers: ${headerTypeName}})`;
                    errorVariants.push(variant);
                  }
                }
                // Always emit variants; do not flatten single-success cases
              }

              // Emit per-status header types
              if (headerTypeDefs.length > 0) {
                for (const t of headerTypeDefs) {
                  lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
                }
              }
              // Emit error aux types
              if (auxTypes.length > 0) {
                for (const t of auxTypes) {
                  const trimmed = t.body.trimStart();
                  if (trimmed.startsWith("/**")) {
                    const idx = trimmed.indexOf("*/");
                    if (idx >= 0) {
                      const doc = trimmed.slice(0, idx + 2);
                      const rest = trimmed.slice(idx + 2).trimStart();
                      lines.push(indentLines(doc, 4));
                      lines.push(indentLines(`type ${t.name} = ${rest}`, 4));
                      continue;
                    }
                  }
                  lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
                }
              }
              // per-operation status alias (success 2xx codes)
              if (successStatusCodes.length > 0) {
                const uniq = Array.from(new Set(successStatusCodes));
                const sorted = uniq.sort((a, b) => Number(a) - Number(b));
                const pv = sorted.map((s) => `#${s}`).join(" | ");
                lines.push(indentLines(`type status = [${pv}]`, 4));
              }
              if (successAuxTypes.length > 0) {
                for (const t of successAuxTypes) {
                  const trimmed = t.body.trimStart();
                  if (trimmed.startsWith("/**")) {
                    const idx = trimmed.indexOf("*/");
                    if (idx >= 0) {
                      const doc = trimmed.slice(0, idx + 2);
                      const rest = trimmed.slice(idx + 2).trimStart();
                      lines.push(indentLines(doc, 4));
                      lines.push(indentLines(`type ${t.name} = ${rest}`, 4));
                      continue;
                    }
                  }
                  lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
                }
              }
              if (successVariants.length >= 1) {
                const body = successVariants.map((v) => `| ${v}`).join("\n  ");
                lines.push(
                  indentLines(`@tag("status")\ntype success =\n  ${body}`, 4)
                );
              } else {
                lines.push(indentLines(`type success = unknown`, 4));
              }
              if (errorVariants.length > 0) {
                const body = errorVariants.map((v) => `| ${v}`).join("\n  ");
                lines.push(
                  indentLines(`@tag("status")\ntype error =\n  ${body}`, 4)
                );
              } else {
                lines.push(indentLines(`type error = unknown`, 4));
              }

              lines.push(indentLines(`}`, 2));
            }
          }
        }
      }
    }
  };

  emitCallbacks(paths);

  lines.push("}");
  return lines;
}

function renderPaths(
  paths: PathsObject | undefined,
  ctx: RSContext
): { lines: string[]; hasClient: boolean } {
  const lines: string[] = [];
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

  // Helper: choose unique type name per path
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

  // Emit per-path operation record types
  const clientFields: string[] = [];
  for (const pe of pathEntries) {
    if (pe.entries.length === 0) continue;
    const typeName = typeNameForPath(pe);
    const fields: string[] = [];
    for (const e of pe.entries) {
      const mod = toValidModuleName(e.opId);
      const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
      const target = toValidResFieldName(e.method);
      const asAttr = `@as(${JSON.stringify(e.method.toUpperCase())}) `;
      fields.push(`${asAttr}${target.rendered}: ${fnType},`);
    }
    lines.push(`type ${typeName} = \n{\n${indentLines(fields, 2)}\n}`);
    lines.push("");
    clientFields.push(`${JSON.stringify(pe.path)}: ${typeName},`);
  }

  let hasClient = false;
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    lines.push(`type client = \n{.\n${indentLines(rows, 2)}\n}`);
    hasClient = true;
  }
  return { lines, hasClient };
}

function renderWebhooks(
  webhooks: OpenAPI3["webhooks"] | undefined,
  ctx: RSContext
): { lines: string[] } {
  const lines: string[] = [];
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
    const fields: string[] = [];
    for (const e of he.entries) {
      const mod = toValidModuleName(e.opId);
      const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
      const target = toValidResFieldName(e.method);
      const asAttr = `@as(${JSON.stringify(e.method.toUpperCase())}) `;
      fields.push(`${asAttr}${target.rendered}: ${fnType},`);
    }
    lines.push(
      `type ${toValidTypeName(`${he.name}_webhook`)} = \n{\n${indentLines(fields, 2)}\n}`
    );
    lines.push("");
  }

  const clientFields: string[] = [];
  for (const he of hookEntries) {
    if (he.entries.length === 0) continue;
    clientFields.push(
      `${JSON.stringify(he.name)}: ${toValidTypeName(`${he.name}_webhook`)},`
    );
  }
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    lines.push(`type webhooks = \n{.\n${indentLines(rows, 2)}\n}`);
  }
  return { lines };
}

function renderCallbacks(
  paths: PathsObject | undefined,
  ctx: RSContext
): { lines: string[] } {
  const lines: string[] = [];
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
    lines.push(`type ${tn} = \n{\n${indentLines(ent.fields, 2)}\n}`);
    lines.push("");
    clientFields.push(`${JSON.stringify(ent.opId)}: ${tn},`);
  }
  if (clientFields.length > 0) {
    const rows = stripLastComma(clientFields);
    lines.push(`type callbacks = \n{.\n${indentLines(rows, 2)}\n}`);
  }
  return { lines };
}
