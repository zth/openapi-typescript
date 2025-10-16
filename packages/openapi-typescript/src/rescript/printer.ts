import { indentLines } from "./utils.js";
import type { RSNode, TypeIR, FieldIR } from "./ir.js";

function printTypeIR(t: TypeIR): string {
  switch (t.kind) {
    case "raw":
      return t.code;
    case "withDoc": {
      const inner = printTypeIR(t.inner);
      return `${t.doc}\n${inner}`;
    }
    case "ref": {
      return t.path.join(".");
    }
    case "app": {
      const callee = printTypeIR(t.callee);
      const args = t.args.map(printTypeIR).join(", ");
      return `${callee}<${args}>`;
    }
    case "record": {
      const lines: string[] = [];
      const emitField = (f: FieldIR) => {
        if (f.doc) lines.push(f.doc);
        const head = `${f.attr ?? ""}${f.name}`;
        const ty = printTypeIR(f.typ);
        if (f.optional === "questionMark") {
          lines.push(`${head}?: ${ty},`);
        } else if (f.optional === "option") {
          lines.push(`${head}: option<${ty}>,`);
        } else {
          lines.push(`${head}: ${ty},`);
        }
      };
      for (const f of t.fields) emitField(f);
      return `\n{\n${indentLines(lines, 2)}\n}`;
    }
    case "poly": {
      const cases = t.cases
        .map((c) =>
          c.payload ? `${c.label}(${printTypeIR(c.payload)})` : `${c.label}`
        )
        .join(" | ");
      return `[${cases}]`;
    }
    case "adt": {
      const cases = t.cases
        .map((c) => {
          const head = `${c.attr ?? ""}${c.label}`;
          return c.payload ? `${head}(${printTypeIR(c.payload)})` : head;
        })
        .join("\n  | ");
      return `| ${cases}`;
    }
    case "tuple": {
      const items = t.items.map(printTypeIR).join(", ");
      return `(${items})`;
    }
  }
}

function printTypeDecl(indent: number, keyword: string, name: string, body: TypeIR): string[] {
  const out: string[] = [];
  if (body.kind === "withDoc") {
    out.push(indentLines(body.doc, indent));
    out.push(indentLines(`${keyword} ${name} = ${printTypeIR(body.inner)}`, indent));
  } else {
    out.push(indentLines(`${keyword} ${name} = ${printTypeIR(body)}`, indent));
  }
  return out;
}

function printNode(node: RSNode, indent: number, out: string[]): void {
  switch (node.kind) {
    case "comment":
      out.push(node.code.trimEnd());
      break;
    case "attr":
      out.push(indentLines(node.code, indent));
      break;
    case "open":
      out.push(indentLines(`open ${node.name}`, indent));
      break;
    case "type": {
      const lines = printTypeDecl(indent, node.keyword, node.name, node.body);
      out.push(...lines);
      break;
    }
    case "raw": {
      const parts = node.code.split("\n");
      for (const p of parts) out.push(indentLines(p, indent));
      break;
    }
    case "blank":
      out.push("");
      break;
    case "module": {
      out.push(indentLines(`module ${node.name} = {`, indent));
      for (const child of node.items) printNode(child, indent + 2, out);
      out.push(indentLines(`}`, indent));
      break;
    }
  }
}

export function printFile(nodes: RSNode[]): string {
  const out: string[] = [];
  for (const n of nodes) printNode(n, 0, out);
  return out.join("\n") + "\n";
}

export { printTypeIR, printTypeDecl };
