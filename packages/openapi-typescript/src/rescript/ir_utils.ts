import type { TypeIR } from "./ir.js";
import { printTypeIR } from "./printer.js";

export function alphaEq(a: TypeIR, b: TypeIR): boolean {
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
      // Conservative: compare printed representations for now
      return printTypeIR(a) === printTypeIR(b);
    }
  }
}

export function isNullApp(t: TypeIR): t is Extract<TypeIR, { kind: "app" }> {
  return (
    t.kind === "app" &&
    t.callee.kind === "ref" &&
    t.callee.path.join(".") === "Null.t" &&
    Array.isArray(t.args) &&
    t.args.length === 1
  );
}

export function unwrapNull(t: TypeIR): TypeIR | undefined {
  if (isNullApp(t)) return t.args[0]!;
  return undefined;
}

export function isRefNamed(t: TypeIR, name: string): boolean {
  return t.kind === "ref" && t.path.join(".") === name;
}

export function isArrayIR(t: TypeIR): t is Extract<TypeIR, { kind: "app" }> & { callee: Extract<TypeIR, { kind: "ref" }> } {
  return t.kind === "app" && t.callee.kind === "ref" && t.callee.path.join(".") === "array" && t.args.length === 1;
}

export function chooseNarrowerIR(a: TypeIR, b: TypeIR): "a" | "b" | undefined {
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

