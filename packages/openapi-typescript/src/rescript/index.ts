import { COMMENT_HEADER } from "../index.js";
import { getEntries } from "../lib/utils.js";
import type { ComponentsObject, OpenAPI3, ReferenceObject, SchemaObject } from "../types.js";
import { RSContext, SchemaLike, RES_KEYWORDS, indentLines, refName, toValidModuleName, toValidResFieldName, toValidTypeName, wrapBlockDoc } from "./utils.js";
import type { PathsObject, PathItemObject, OperationObject, RequestBodyObject } from "../types.js";

function isRef(s: any): s is ReferenceObject {
  return s && typeof s === "object" && typeof s.$ref === "string";
}

function mapPrimitive(schema: SchemaObject): string | undefined {
  const t = schema.type;
  if (t === "string") return "string";
  if (t === "number" || t === "integer") return "float";
  if (t === "boolean") return "bool";
  return undefined;
}

function mapSchemaToRes(
  schema: SchemaLike,
  ctx: RSContext,
  { parentName, collectAux }: { parentName?: string; collectAux?: (name: string, body: string) => void } = {},
): string {
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

  // enums: strings or numbers → PV union with deterministic ordering
  if (Array.isArray((schema as any).enum) && (schema as any).enum.length > 0) {
    const vals = (schema as any).enum as any[];
    const allStrings = vals.every((v) => typeof v === "string");
    const allNumbers = vals.every((v) => typeof v === "number");
    if (allStrings || allNumbers) {
      const sorted = [...vals].sort((a, b) => (a as any).toString().localeCompare((b as any).toString()));
      const label = (v: string): string => {
        const isIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
        const isReserved = RES_KEYWORDS.has(v);
        return isIdent && !isReserved ? `#${v}` : `#${JSON.stringify(v)}`;
      };
      const tags = sorted.map((v) => label(String(v)));
      const pv = `[${tags.join(" | ")}]`;
      return (schema as any).nullable ? `Null.t<${pv}>` : pv;
    }
  }

  // Hoist $defs within this schema into aux types on the same rec chain
  if ((schema as any).$defs && typeof (schema as any).$defs === "object" && typeof collectAux === "function") {
    const defs = (schema as any).$defs as Record<string, any>;
    for (const [k, v] of Object.entries(defs)) {
      const auxName = `${parentName ?? "t"}__def_${toValidTypeName(k)}`;
      const body = mapSchemaToRes(v as SchemaLike, ctx, { parentName: auxName, collectAux });
      collectAux(auxName, body);
    }
  }

  // basic primitives
  const prim = mapPrimitive(schema as any);
  if (prim) {
    return (schema as any).nullable ? `Null.t<${prim}>` : prim;
  }

  // arrays
  if (schema.type === "array") {
    const it = (schema.items as SchemaLike) ?? ({} as SchemaObject);
    const inner = mapSchemaToRes(it, ctx, { parentName, collectAux });
    return schema.nullable ? `Null.t<array<${inner}>>` : `array<${inner}>`;
  }

  // composition: oneOf / anyOf → PV union wrapped in Wrapped.t when possible
  const unionMembers = (schema as any).oneOf ?? (schema as any).anyOf;
  if (Array.isArray(unionMembers) && unionMembers.length > 0) {
    type Member = SchemaLike;
    const members = unionMembers as Member[];
    const allRefs = members.every((m) => !!(m as any).$ref);
    // Prepare discriminator mapping if present
    const disc = (schema as any)?.discriminator;
    let mapRefNameToLabel: Map<string, string> | undefined;
    if (disc && typeof disc === "object" && disc.mapping && typeof disc.mapping === "object") {
      mapRefNameToLabel = new Map<string, string>();
      for (const [val, refStr] of Object.entries(disc.mapping as Record<string, string>)) {
        const rn = typeof refStr === "string" ? refName(refStr) : undefined;
        if (rn) mapRefNameToLabel.set(rn, toValidModuleName(val));
      }
    }
    if (allRefs) {
      // Union of refs → Wrapped.t of PV constructors referencing component types
      const seen = new Set<string>();
      const ctors: string[] = [];
      for (const m of members) {
        const $ref = (m as any).$ref as string;
        const typeNm = refName($ref) ?? "unknown";
        // Infer label from discriminator property when mapping is absent
        let inferred: string | undefined;
        if (disc && typeof disc === "object" && (disc as any).propertyName) {
          const resolved = ctx.resolve($ref);
          const propName = (disc as any).propertyName as string;
          if (resolved && typeof resolved === "object") {
            const props = (resolved as any).properties ?? {};
            const ds = props ? props[propName] : undefined;
            const val = ds && typeof ds === "object" && ("const" in (ds as any) ? (ds as any).const : Array.isArray((ds as any).enum) && (ds as any).enum.length === 1 ? (ds as any).enum[0] : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
        }
        let label = mapRefNameToLabel?.get(typeNm) ?? inferred ?? toValidModuleName(typeNm);
        // ensure unique labels if duplicates
        let uniq = label;
        let i = 2;
        while (seen.has(uniq)) uniq = `${label}_${i++}`;
        seen.add(uniq);
        ctors.push(`#${uniq}(${typeNm})`);
      }
      const pv = `[${ctors.join(" | ")}]`;
      const wrapped = `Wrapped.t<${pv}>`;
      return (schema as any).nullable ? `Null.t<${wrapped}>` : wrapped;
    }

    // Mixed/inline members: generate aux types for inline object members to avoid inline records in PV payloads
    const seen = new Set<string>();
    const ctors: string[] = [];
    members.forEach((m, idx) => {
      if ((m as any)?.$ref) {
        const $ref = (m as any).$ref as string;
        const typeNm = refName($ref) ?? "unknown";
        let inferred: string | undefined;
        if (disc && typeof disc === "object" && (disc as any).propertyName) {
          const resolved = ctx.resolve($ref);
          const propName = (disc as any).propertyName as string;
          if (resolved && typeof resolved === "object") {
            const props = (resolved as any).properties ?? {};
            const ds = props ? props[propName] : undefined;
            const val = ds && typeof ds === "object" && ("const" in (ds as any) ? (ds as any).const : Array.isArray((ds as any).enum) && (ds as any).enum.length === 1 ? (ds as any).enum[0] : undefined);
            if (val !== undefined) inferred = toValidModuleName(String(val));
          }
        }
        let label = mapRefNameToLabel?.get(typeNm) ?? inferred ?? toValidModuleName(typeNm);
        let uniq = label;
        let i = 2;
        while (seen.has(uniq)) uniq = `${label}_${i++}`;
        seen.add(uniq);
        ctors.push(`#${uniq}(${typeNm})`);
      } else {
        // Map the member; if it is an inline record, lift to an aux type
        const mapped = mapSchemaToRes(m, ctx, { parentName, collectAux });
        const isInlineRecord = /^\s*\{/.test(mapped);
        if (isInlineRecord && typeof collectAux === "function") {
          const base = toValidTypeName(`${parentName ?? "t"}_member_${idx + 1}`);
          let auxName = base;
          // naive uniqueness: try suffix increment until no clash
          let j = 2;
          // We cannot check global uniqueness here; assume caller places within single rec chain and base is unique per parent
          collectAux(auxName, mapped);
          // Try infer label from inline member's discriminator property
          let inferred: string | undefined;
          if (disc && typeof disc === "object" && (disc as any).propertyName) {
            const propName = (disc as any).propertyName as string;
            const mm = m as any;
            const props = (mm && typeof mm === "object" ? (mm.properties ?? {}) : {});
            const ds = props ? props[propName] : undefined;
            const val = ds && typeof ds === "object" && ("const" in (ds as any) ? (ds as any).const : Array.isArray((ds as any).enum) && (ds as any).enum.length === 1 ? (ds as any).enum[0] : undefined);
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
          if (disc && typeof disc === "object" && (disc as any).propertyName) {
            const propName = (disc as any).propertyName as string;
            const mm = m as any;
            const props = (mm && typeof mm === "object" ? (mm.properties ?? {}) : {});
            const ds = props ? props[propName] : undefined;
            const val = ds && typeof ds === "object" && ("const" in (ds as any) ? (ds as any).const : Array.isArray((ds as any).enum) && (ds as any).enum.length === 1 ? (ds as any).enum[0] : undefined);
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
    return (schema as any).nullable ? `Null.t<${wrapped}>` : wrapped;
  }

  // (enum mapping handled above)

  // objects with properties
  if (schema.type === "object" || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const props = schema.properties ?? {};
    const fields: string[] = [];
    const used: Set<string> = new Set();
    const propEntries = Object.entries(props);

    // patternProperties → treat as dict<JSON.t> when no explicit properties
    if (
      propEntries.length === 0 &&
      (schema as any).patternProperties &&
      typeof (schema as any).patternProperties === "object" &&
      Object.keys((schema as any).patternProperties).length > 0
    ) {
      return schema.nullable ? `Null.t<dict<JSON.t>>` : `dict<JSON.t>`;
    }

    // If no explicit properties and we only have additionalProperties, treat as dict
    if (propEntries.length === 0 && (schema as any).additionalProperties !== undefined) {
      const ap = (schema as any).additionalProperties;
      if (ap === true) {
        return schema.nullable ? `Null.t<dict<JSON.t>>` : `dict<JSON.t>`;
      }
      if (ap === false) {
        return schema.nullable ? `Null.t<emptyObject>` : `emptyObject`;
      }
      const inner = mapSchemaToRes(ap as SchemaLike, ctx, { parentName, collectAux });
      return schema.nullable ? `Null.t<dict<${inner}>>` : `dict<${inner}>`;
    }

    for (const [propName, propSchema] of Object.entries(props)) {
      const mapped = mapSchemaToRes(propSchema as SchemaLike, ctx, { parentName, collectAux });
      const isReq = required.has(propName);
      const { rendered, attr } = toValidResFieldName(propName);
      // naive unique handling: suffix if duplicate
      let name = rendered;
      let i = 2;
      while (used.has(name)) name = `${rendered}__${i++}`;
      used.add(name);
      const sep = isReq ? ": " : "?: ";
      const line = `${attr ?? ""}${name}${sep}${mapped},`;
      fields.push(line);
    }
    const body = `\n{\n${indentLines(fields, 2)}\n}`;
    return schema.nullable ? `Null.t<${body}>` : body;
  }

  // composition: allOf → merge object properties where possible; others unknown
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // Try to merge object-like members
    const members = schema.allOf as SchemaLike[];
    const fields: string[] = [];
    const used = new Set<string>();
    for (const member of members) {
      const mapped = mapSchemaToRes(member, ctx, { parentName, collectAux });
      // If member rendered as inline record { .. }, extract fields
      const m = mapped.trim();
      if (m.startsWith("{") || m.startsWith("{\n")) {
        const body = m.replace(/^\{\n?/, "").replace(/\n?\}$/, "");
        for (const line of body.split("\n").filter(Boolean)) {
          // Keep as-is; ensure uniqueness by suffixing name if needed later (best-effort)
          fields.push(line);
        }
      } else {
        // Non-object member; bail out to unknown for now
        return "unknown";
      }
    }
    const body = `\n{\n${fields.join("\n")}\n}`;
    return schema.nullable ? `Null.t<${body}>` : body;
  }

  return "unknown";
}

function renderComponentsSchemas(components: ComponentsObject | undefined, ctx: RSContext): string[] {
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
      let topDoc = (schema as SchemaObject)?.description ?? undefined;
      const s = schema as SchemaObject;
      if (s && typeof s === "object") {
        const notes: string[] = [];
        const hasArray = s.type === "array" || Array.isArray((s as any).prefixItems) || Array.isArray((s as any).items);
        if (hasArray) {
          if (typeof (s as any).minItems === "number") notes.push(`minItems: ${(s as any).minItems}`);
          if (typeof (s as any).maxItems === "number") notes.push(`maxItems: ${(s as any).maxItems}`);
          const pi = Array.isArray((s as any).prefixItems)
            ? (s as any).prefixItems.length
            : Array.isArray((s as any).items)
            ? (s as any).items.length
            : undefined;
          if (typeof pi === "number") notes.push(`prefixItems: ${pi}`);
        }
        // patternProperties regexes (doc note only)
        if ((s as any).patternProperties && typeof (s as any).patternProperties === "object") {
          const patterns = Object.keys((s as any).patternProperties);
          if (patterns.length > 0) notes.push(`pattern regexes: ${patterns.join(", ")}`);
        }
        if (notes.length > 0) {
          const line = `Constraints: ${notes.join("; ")}`;
          topDoc = topDoc ? `${topDoc}\n${line}` : line;
        }
      }
      const body = mapSchemaToRes(schema as SchemaLike, ctx, {
        parentName: typeName,
        collectAux: (n, b) => aux.push({ name: n, body: b }),
      });
      const doc = wrapBlockDoc(topDoc);
      const kw = idx === 0 ? "type rec" : "and";
      const decl = `${doc ? doc + "\n" : ""}${kw} ${typeName} = ${body}`;
      decls.push(decl);
      if (aux.length > 0) {
        for (const t of aux) {
          decls.push(`and ${t.name} = ${t.body}`);
        }
      }
    });
    lines.push(indentLines(decls.join("\n"), 4));
  }

  lines.push(indentLines("}", 2));
  // Headers aggregator submodule
  lines.push(indentLines("module Headers = {", 2));
  const hdrs: Record<string, any> = (components as any)?.headers ?? {};
  const hdrEntries = Object.entries(hdrs);
  if (hdrEntries.length > 0) {
    const fields: string[] = [];
    for (const [name, headerLike] of hdrEntries) {
      const header = (headerLike as any)?.$ref ? ctx.resolve((headerLike as any).$ref) : headerLike;
      let actual: string = "string";
      if (header && typeof header === "object") {
        if ((header as any).schema) actual = mapSchemaToRes((header as any).schema as SchemaLike, ctx, {});
        else if ((header as any).content && typeof (header as any).content === "object") {
          const ents = Object.entries((header as any).content) as Array<[string, any]>;
          const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
          const chosen = chosenEntry?.[1];
          if (chosen && chosen.schema) actual = mapSchemaToRes(chosen.schema as SchemaLike, ctx, {});
          else actual = "unknown";
        }
      }
      const fn = toValidResFieldName(name);
      const field = `${fn.attr ?? ""}${fn.rendered}?: string,`;
      if (actual !== "string") {
        const doc = wrapBlockDoc(`actual: ${actual}`);
        if (doc) fields.push(doc);
      }
      fields.push(field);
    }
    lines.push(indentLines(`type response = \n{\n${indentLines(fields, 2)}\n}`, 4));
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
  // Bring OpenAPIFetch helpers (emptyObject, Wrapped, etc.) into scope
  out.push("open OpenAPIFetch\n");

  // Start with Components.Schemas only (Phase 0)
  out.push(...renderComponentsSchemas(schema.components, ctx));

  // Minimal Operations emission (modules only with placeholders)
  out.push(...renderOperations(schema.paths, (schema as any)?.webhooks, ctx));

  // Paths & Client types
  const { lines: pathLines, hasClient } = renderPaths(schema.paths, ctx);
  out.push(...pathLines);
  if (hasClient) {
    out.push(
      "",
      '@module("openapi-fetch")',
      'external createClient: createClientOptions => Client.clientContainer<client> = "createClient"',
      "",
      'let createClient = options => createFetchClient(createClient(options))',
      "",
    );
  }

  // Webhooks types
  const { lines: webhookLines } = renderWebhooks((schema as any)?.webhooks, ctx);
  out.push(...webhookLines);

  // Callbacks types
  const { lines: callbackLines } = renderCallbacks(schema.paths, ctx);
  out.push(...callbackLines);

  return out.join("\n") + "\n";
}

function resolveOperation(op: OperationObject | ReferenceObject | undefined, ctx: RSContext): OperationObject | undefined {
  if (!op) return undefined;
  if ((op as any).$ref) {
    const resolved = ctx.resolve((op as any).$ref);
    if (resolved && typeof resolved === "object" && !("$ref" in resolved)) return resolved as OperationObject;
    return undefined;
  }
  return op as OperationObject;
}

function renderOperations(paths: PathsObject | undefined, webhooks: any, ctx: RSContext): string[] {
  const lines: string[] = [];
  lines.push("module Operations = {");
  // Bring Components submodules (Schemas, Parameters, Headers, Responses) into scope
  lines.push(indentLines("open Components", 2));

  function emitForContainer(container: any) {
    if (!(container && typeof container === "object")) return;
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
        const op = resolveOperation((item as any)[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        let opName: string | undefined = undefined;
        if (opId && typeof opId === "string" && opId.length > 0) opName = opId;
        else opName = `${String(p)}_${String(m)}`;
        const mod = toValidModuleName(opName);
        lines.push(indentLines(`module ${mod} = {`, 2));
        // PARAMETERS: collect from path-level + op-level
        const allParams: (any)[] = [];
        const pathParams = (item as any)?.parameters as (any[] | undefined);
        if (Array.isArray(pathParams)) allParams.push(...pathParams);
        const opParams = (op as any)?.parameters as (any[] | undefined);
        if (Array.isArray(opParams)) allParams.push(...opParams);

        type GroupKey = "query" | "header" | "path" | "cookie";
        const groups: Record<GroupKey, string[]> = { query: [], header: [], path: [], cookie: [] };
        const present: Set<GroupKey> = new Set();
        for (const p of allParams) {
          const param = (p && typeof p === "object" && (p as any).$ref) ? ctx.resolve((p as any).$ref) : p;
          if (!param || typeof param !== "object") continue;
          const where = (param as any).in as GroupKey;
          const name = (param as any).name as string;
          if (!where || !name) continue;
          const required = !!(param as any).required;
          const schema = (param as any).schema as SchemaLike | undefined;
          let ty = "unknown";
          if (schema) {
            ty = mapSchemaToRes(schema, ctx, {});
          }
          const fname = toValidResFieldName(name);
          const sep = required ? ": " : "?: ";
          groups[where].push(`${fname.attr ?? ""}${fname.rendered}${sep}${ty},`);
          present.add(where);
        }

        const paramTypeDecls: string[] = [];
        const fieldOrder: GroupKey[] = ["query", "header", "path", "cookie"];
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
          lines.push(indentLines(`type params = \n{\n${indentLines(paramsFields, 2)}\n}`, 4));
        }

        // REQUEST BODY: prefer application/json schema
        let bodyType: string | undefined = undefined;
        const rb = (op as any)?.requestBody as RequestBodyObject | { $ref: string } | undefined;
        if (rb) {
          const req = (rb as any).$ref ? (ctx.resolve((rb as any).$ref) as RequestBodyObject | undefined) : (rb as RequestBodyObject);
          const content = req && (req as any).content && typeof (req as any).content === "object" ? (req as any).content : undefined;
          if (content) {
            const entries = Object.entries(content) as Array<[string, any]>;
            let chosen: any | undefined = undefined;
            for (const [k, v] of entries) {
              if (k === "application/json") { chosen = v; break; }
            }
            if (!chosen && entries.length === 1) chosen = entries[0]![1];
            if (chosen && typeof chosen === "object" && chosen.schema) {
              const mapped = mapSchemaToRes(chosen.schema as SchemaLike, ctx, {});
              bodyType = mapped;
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
          lines.push(indentLines(`type parameters = \n{\n${indentLines(parametersFields, 2)}\n}`, 4));
        } else {
          lines.push(indentLines(`type parameters = emptyObject`, 4));
        }
        // RESPONSES: status-tagged variants for multi-2xx and non-2xx/default
        type ResponseLike = { $ref?: string } | any;
        const responses = (op as any)?.responses as Record<string, ResponseLike> | undefined;
        let singleSuccess: { code: string; ty: string } | undefined;
        const successVariants: string[] = [];
        const successPayloadTypes: string[] = [];
        const successStatusCodes: string[] = [];
        const errorVariants: string[] = [];
        const usedSuccessCtors: Set<string> = new Set();
        const usedErrorCtors: Set<string> = new Set();
        const auxTypes: { name: string; body: string }[] = [];
        const addAuxType = (name: string, body: string) => {
          if (!auxTypes.some((t) => t.name === name)) auxTypes.push({ name, body });
        };
        const successAuxTypes: { name: string; body: string }[] = [];
        const addSuccessAuxType = (name: string, body: string) => {
          if (!successAuxTypes.some((t) => t.name === name)) successAuxTypes.push({ name, body });
        };

        if (responses && typeof responses === "object") {
          // Collect success bodies for flattening case as well
          const bodies: { code: string; ty: string }[] = [];
          for (const [status, respLike] of Object.entries(responses)) {
            const isDefault = status === "default";
            const n = parseInt(status, 10);
            const is2xx = !isNaN(n) && n >= 200 && n < 300;
            const refNameForCtor = ((): string | undefined => {
              const r = (respLike as any)?.$ref as string | undefined;
              if (r && typeof r === "string") {
                const nm = refName(r);
                if (nm) return nm[0]!.toUpperCase() + nm.slice(1);
              }
              return undefined;
            })();

            const resolved = (respLike as any)?.$ref ? (ctx.resolve((respLike as any).$ref) as any) : (respLike as any);
            const content = resolved && typeof resolved === "object" ? (resolved as any).content : undefined;
            let body: string | undefined;
            if (content && typeof content === "object") {
              const entries = Object.entries(content) as Array<[string, any]>;
              let chosen: any | undefined = undefined;
              for (const [k, v] of entries) { if (k === "application/json") { chosen = v; break; } }
              if (!chosen && entries.length === 1) chosen = entries[0]![1];
              if (chosen && chosen.schema) {
                body = mapSchemaToRes(chosen.schema as SchemaLike, ctx, {});
              } else {
                body = "unknown";
              }
            } else {
              body = "unknown";
            }

            if (is2xx) bodies.push({ code: status, ty: body ?? "unknown" });

            // Constructor naming similar to src/main.ts
            const ctorBase = refNameForCtor ?? "Data";
            const asAttr = isDefault ? `@as("default") ` : !isNaN(n) ? `@as(${status}) ` : undefined;

            if (is2xx) {
              // success variants accumulate for multi-2xx
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
              }
              const variant = `${asAttr ?? ""}${c}({data: ${payload}, response: Response.t, headers: Components.Headers.response})`;
              successVariants.push(variant);
              successPayloadTypes.push(body ?? "unknown");
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
                const auxName = toValidTypeName(`status_${isDefault ? "default" : status}_error`);
                addAuxType(auxName, payload);
                payload = auxName;
              }
              const variant = `${asAttr ?? ""}${c}({error: ${payload}, response: Response.t, headers: Components.Headers.response})`;
              errorVariants.push(variant);
            }
          }
          if (bodies.length === 1) singleSuccess = bodies[0];
        }

        // Emit any aux types derived from inline record payloads
        if (auxTypes.length > 0) {
          for (const t of auxTypes) {
            lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
          }
        }

        if (singleSuccess && successVariants.length <= 1) {
          const statusCtor = `[#${singleSuccess.code}]`;
          const rec = `{data: ${singleSuccess.ty}, response: Response.t, headers: Components.Headers.response, status: ${statusCtor}}`;
          lines.push(indentLines(`type success = ${rec}`, 4));
        } else if (successVariants.length > 1) {
          // If we render variants, also include aux types needed for success payloads
          if (successAuxTypes.length > 0) {
            for (const t of successAuxTypes) {
              lines.push(indentLines(`type ${t.name} = ${t.body}`, 4));
            }
          }
          const body = successVariants.map((v) => `| ${v}`).join("\n  ");
          lines.push(indentLines(`@tag("status")\ntype success =\n  ${body}`, 4));
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
  const emitCallbacks = (container: any) => {
    if (!(container && typeof container === "object")) return;
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
        const op = resolveOperation((item as any)[m], ctx);
        if (!op) continue;
        const baseName = (op.operationId && typeof op.operationId === "string" && op.operationId.length > 0)
          ? op.operationId
          : `${String(p)}_${String(m)}`;
        const callbacks = (op as any)?.callbacks;
        if (!callbacks || typeof callbacks !== "object") continue;
        for (const [cbName, cbVal] of Object.entries(callbacks)) {
          const cbResolved = (cbVal && typeof cbVal === "object" && (cbVal as any).$ref)
            ? ctx.resolve((cbVal as any).$ref)
            : cbVal;
          if (!cbResolved || typeof cbResolved !== "object") continue;
          for (const [expr, cbPathItemLike] of Object.entries(cbResolved as any)) {
            const cbItem = (cbPathItemLike && typeof cbPathItemLike === "object" && (cbPathItemLike as any).$ref)
              ? ctx.resolve((cbPathItemLike as any).$ref)
              : cbPathItemLike;
            if (!cbItem || typeof cbItem !== "object") continue;
            for (const m2 of METHODS) {
              const cbOp = resolveOperation((cbItem as any)[m2], ctx);
              if (!cbOp) continue;
              const mod = toValidModuleName(`${baseName}_${cbName}_${m2}`);
              lines.push(indentLines(`module ${mod} = {`, 2));

              // PARAMETERS for callback op: collect from callback path-level + op-level
              const allParams: (any)[] = [];
              const pathParams = (cbItem as any)?.parameters as (any[] | undefined);
              if (Array.isArray(pathParams)) allParams.push(...pathParams);
              const opParams = (cbOp as any)?.parameters as (any[] | undefined);
              if (Array.isArray(opParams)) allParams.push(...opParams);

              type GroupKey = "query" | "header" | "path" | "cookie";
              const groups: Record<GroupKey, string[]> = { query: [], header: [], path: [], cookie: [] };
              const present: Set<GroupKey> = new Set();
              for (const p of allParams) {
                const param = (p && typeof p === "object" && (p as any).$ref) ? ctx.resolve((p as any).$ref) : p;
                if (!param || typeof param !== "object") continue;
                const where = (param as any).in as GroupKey;
                const name = (param as any).name as string;
                if (!where || !name) continue;
                const required = !!(param as any).required;
                const schema = (param as any).schema as SchemaLike | undefined;
                let ty = "unknown";
                if (schema) {
                  ty = mapSchemaToRes(schema, ctx, {});
                }
                const fname = toValidResFieldName(name);
                const sep = required ? ": " : "?: ";
                groups[where].push(`${fname.attr ?? ""}${fname.rendered}${sep}${ty},`);
                present.add(where);
              }

              const fieldOrder: GroupKey[] = ["query", "header", "path", "cookie"];
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
                lines.push(indentLines(`type params = \n{\n${indentLines(paramsFields, 2)}\n}`, 4));
              }

              // REQUEST BODY
              let bodyType: string | undefined = undefined;
              const rb = (cbOp as any)?.requestBody as RequestBodyObject | { $ref: string } | undefined;
              if (rb) {
                const req = (rb as any).$ref ? (ctx.resolve((rb as any).$ref) as RequestBodyObject | undefined) : (rb as RequestBodyObject);
                const content = req && (req as any).content && typeof (req as any).content === "object" ? (req as any).content : undefined;
                if (content) {
                  const entries = Object.entries(content) as Array<[string, any]>;
                  let chosen: any | undefined = undefined;
                  for (const [k, v] of entries) { if (k === "application/json") { chosen = v; break; } }
                  if (!chosen && entries.length === 1) chosen = entries[0]![1];
                  if (chosen && typeof chosen === "object" && chosen.schema) {
                    bodyType = mapSchemaToRes(chosen.schema as SchemaLike, ctx, {});
                  } else {
                    bodyType = "JSON.t";
                  }
                }
              }

              const parametersFields: string[] = [];
              if (present.size > 0) parametersFields.push("params?: params,");
              if (bodyType) parametersFields.push(`body?: ${bodyType},`);
              if (parametersFields.length > 0) {
                lines.push(indentLines(`type parameters = \n{\n${indentLines(parametersFields, 2)}\n}`, 4));
              } else {
                lines.push(indentLines(`type parameters = emptyObject`, 4));
              }

              // RESPONSES
              type ResponseLike = { $ref?: string } | any;
              const responses = (cbOp as any)?.responses as Record<string, ResponseLike> | undefined;
              let singleSuccess: { code: string; ty: string } | undefined;
              const successVariants: string[] = [];
              const successPayloadTypes: string[] = [];
              const successStatusCodes: string[] = [];
              const errorVariants: string[] = [];
              const auxTypes: Array<{ name: string; body: string }> = [];
              const successAuxTypes: Array<{ name: string; body: string }> = [];
              const addAuxType = (name: string, body: string) => auxTypes.push({ name, body });
              const addSuccessAuxType = (name: string, body: string) => successAuxTypes.push({ name, body });
              const usedSuccessCtors = new Set<string>();
              const usedErrorCtors = new Set<string>();
              if (responses && typeof responses === "object") {
                const entries = Object.entries(responses);
                const bodies: Array<{ code: string; ty: string }> = [];
                for (const [status, respLike] of entries) {
                  const resp = (respLike && typeof respLike === "object" && (respLike as any).$ref) ? ctx.resolve((respLike as any).$ref) : respLike;
                  if (!resp || typeof resp !== "object") continue;
                  let body: string | undefined;
                  if ((resp as any).content && typeof (resp as any).content === "object") {
                    const ents = Object.entries((resp as any).content) as Array<[string, any]>;
                    const chosenEntry = ents.find(([k]) => k === "application/json") ?? ents[0];
                    const chosen = chosenEntry?.[1];
                    if (chosen && chosen.schema) body = mapSchemaToRes(chosen.schema as SchemaLike, ctx, {});
                  }
                  const isDefault = status === "default";
                  const n = Number(status);
                  const is2xx = !isNaN(n) && n >= 200 && n < 300;
                  const refNameForCtor = (resp as any)?.$ref ? refName((resp as any).$ref) : undefined;
                  if (is2xx && body) bodies.push({ code: status, ty: body });

                  if (is2xx) {
                    const ctorBase = refNameForCtor ?? "Data";
                    const asAttr = isDefault ? `@as("default") ` : !isNaN(n) ? `@as(${status}) ` : undefined;
                    const ctor = isDefault ? `${ctorBase}Default` : `${ctorBase}S${status}`;
                    let c = ctor; let i = 2; while (usedSuccessCtors.has(c)) c = `${ctor}_${i++}`; usedSuccessCtors.add(c);
                    let payload = body ?? "unknown";
                    const isInlineRecord = /^\s*\{/.test(payload);
                    if (isInlineRecord) { const auxName = toValidTypeName(`status_${status}_body`); addSuccessAuxType(auxName, payload); payload = auxName; }
                    const variant = `${asAttr ?? ""}${c}({data: ${payload}, response: Response.t, headers: Components.Headers.response})`;
                    successVariants.push(variant);
                    successPayloadTypes.push(body ?? "unknown");
                    successStatusCodes.push(status);
                  } else {
                    let c = refNameForCtor ?? "Error";
                    if (usedErrorCtors.has(c)) { c = isDefault ? `${c}Default` : `${c}S${status}`; let j = 2; while (usedErrorCtors.has(c)) c = `${c}_${j++}`; }
                    usedErrorCtors.add(c);
                    let payload = body ?? "unknown";
                    const isInlineRecord = /^\s*\{/.test(payload);
                    if (isInlineRecord) { const auxName = toValidTypeName(`status_${isDefault ? "default" : status}_error`); addAuxType(auxName, payload); payload = auxName; }
                    const asAttr = isDefault ? `@as("default") ` : !isNaN(Number(status)) ? `@as(${status}) ` : undefined;
                    const variant = `${asAttr ?? ""}${c}({error: ${payload}, response: Response.t, headers: Components.Headers.response})`;
                    errorVariants.push(variant);
                  }
                }
                if (bodies.length === 1) singleSuccess = bodies[0];
              }

              if (auxTypes.length > 0) { for (const t of auxTypes) { lines.push(indentLines(`type ${t.name} = ${t.body}`, 4)); } }
              if (singleSuccess && successVariants.length <= 1) {
                const statusCtor = `[#${singleSuccess.code}]`;
                const rec = `{data: ${singleSuccess.ty}, response: Response.t, headers: Components.Headers.response, status: ${statusCtor}}`;
                lines.push(indentLines(`type success = ${rec}`, 4));
              } else if (successVariants.length > 1) {
                if (successAuxTypes.length > 0) { for (const t of successAuxTypes) { lines.push(indentLines(`type ${t.name} = ${t.body}`, 4)); } }
                const body = successVariants.map((v) => `| ${v}`).join("\n  ");
                lines.push(indentLines(`@tag("status")\ntype success =\n  ${body}`, 4));
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
      }
    }
  };

  emitCallbacks(paths);

  lines.push("}");
  return lines;
}

function renderPaths(paths: PathsObject | undefined, ctx: RSContext): { lines: string[]; hasClient: boolean } {
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
      if (!item || typeof item !== "object") continue;
      const entries: MethodEntry[] = [];
      for (const m of METHODS) {
        const op = resolveOperation((item as any)[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        if (!opId || typeof opId !== "string" || opId.length === 0) continue;
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
      const target = toValidResFieldName(e.method as string);
      const asAttr = `@as(${JSON.stringify((e.method as string).toUpperCase())}) `;
      fields.push(`${asAttr}${target.rendered}: ${fnType},`);
    }
    lines.push(`type ${typeName} = \n{\n${indentLines(fields, 2)}\n}`);
    lines.push("");
    clientFields.push(`${JSON.stringify(pe.path)}: ${typeName},`);
  }

  let hasClient = false;
  if (clientFields.length > 0) {
    lines.push(`type client = \n{.\n${indentLines(clientFields, 2)}\n}`);
    hasClient = true;
  }
  return { lines, hasClient };
}

function renderWebhooks(webhooks: any, ctx: RSContext): { lines: string[] } {
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
      if (!item || typeof item !== "object") continue;
      const entries: MethodEntry[] = [];
      for (const m of METHODS) {
        const op = resolveOperation((item as any)[m], ctx);
        if (!op) continue;
        const opId = op.operationId;
        const effective = opId && typeof opId === "string" && opId.length > 0 ? opId : `${name}_${m}`;
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
      const target = toValidResFieldName(e.method as string);
      const asAttr = `@as(${JSON.stringify((e.method as string).toUpperCase())}) `;
      fields.push(`${asAttr}${target.rendered}: ${fnType},`);
    }
    lines.push(`type ${toValidTypeName(`${he.name}_webhook`)} = \n{\n${indentLines(fields, 2)}\n}`);
    lines.push("");
  }

  const clientFields: string[] = [];
  for (const he of hookEntries) {
    if (he.entries.length === 0) continue;
    clientFields.push(`${JSON.stringify(he.name)}: ${toValidTypeName(`${he.name}_webhook`)},`);
  }
  if (clientFields.length > 0) {
    lines.push(`type webhooks = \n{.\n${indentLines(clientFields, 2)}\n}`);
  }
  return { lines };
}

function renderCallbacks(paths: PathsObject | undefined, ctx: RSContext): { lines: string[] } {
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
      if (!item || typeof item !== "object") continue;
      for (const m of METHODS) {
        const op = resolveOperation((item as any)[m], ctx);
        if (!op) continue;
        const opId = op.operationId && typeof op.operationId === "string" && op.operationId.length > 0
          ? op.operationId
          : `${String(p)}_${String(m)}`;
        const callbacks = (op as any)?.callbacks;
        if (!callbacks || typeof callbacks !== "object") continue;
        for (const [cbName, cbVal] of Object.entries(callbacks)) {
          const cbResolved = (cbVal && typeof cbVal === "object" && (cbVal as any).$ref)
            ? ctx.resolve((cbVal as any).$ref)
            : cbVal;
          if (!cbResolved || typeof cbResolved !== "object") continue;
          for (const [expr, cbPathItemLike] of Object.entries(cbResolved as any)) {
            const cbItem = (cbPathItemLike && typeof cbPathItemLike === "object" && (cbPathItemLike as any).$ref)
              ? ctx.resolve((cbPathItemLike as any).$ref)
              : cbPathItemLike;
            if (!cbItem || typeof cbItem !== "object") continue;
            for (const m2 of METHODS) {
              const cbOp = resolveOperation((cbItem as any)[m2], ctx);
              if (!cbOp) continue;
              const mod = toValidModuleName(`${opId}_${cbName}_${m2}`);
              const fnType = `fetchFn<Operations.${mod}.parameters, Operations.${mod}.success, Operations.${mod}.error>`;
              const target = toValidResFieldName(`${cbName}_${m2}`);
              const asAttr = `@as(${JSON.stringify((m2 as string).toUpperCase())}) `;
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
    lines.push(`type callbacks = \n{.\n${indentLines(clientFields, 2)}\n}`);
  }
  return { lines };
}
