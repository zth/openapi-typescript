import { createConfig } from "@redocly/openapi-core";
import { validateAndBundle } from "../src/lib/redoc.js";
import { resolveRef } from "../src/lib/utils.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import type { OpenAPI3 } from "../src/types.js";
import type { RSContext } from "../src/rescript/utils.js";

async function buildSchemaFromFile(filePath: string): Promise<OpenAPI3> {
  const redoc = await createConfig(
    { rules: { "operation-operationId-unique": { severity: "error" } } },
    { extends: ["minimal"] }
  );
  const schema = await validateAndBundle(pathToFileURL(filePath), {
    redoc,
    cwd: new URL(`file://${process.cwd()}/`),
    silent: true,
  });
  return schema as OpenAPI3;
}

function makeCtx(schema: OpenAPI3): RSContext {
  return {
    alphabetize: false,
    excludeDeprecated: false,
    silent: true,
    resolve: <T = unknown>($ref: string) =>
      resolveRef(schema, $ref, { silent: true }) as T | undefined,
  };
}

async function main() {
  const examplesDir = path.resolve(__dirname, "../examples");
  // find all .yaml/.yml/.json files under examples and attempt to bundle as OpenAPI 3.x
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) out.push(...walk(full));
      else if (d.isFile() && /\.(ya?ml|json)$/i.test(d.name)) out.push(full);
    }
    return out;
  };
  const allFiles = walk(examplesDir);
  const candidates: string[] = [];
  for (const p of allFiles) {
    try {
      await buildSchemaFromFile(p);
      candidates.push(p);
    } catch {
      // skip non-OpenAPI 3.x or invalid docs
    }
  }

  const distPath = path.resolve(__dirname, "../dist/rescript/index.mjs");
  const dist = await import(pathToFileURL(distPath).toString());
  const src = await import(
    pathToFileURL(
      path.resolve(__dirname, "../src/rescript/index.ts")
    ).toString()
  );

  let allMatch = true;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const schema = await buildSchemaFromFile(p);
    const ctx = makeCtx(schema);
    const a = (dist as any).emitReScript(schema, ctx) as string;
    const b = (src as any).emitReScript(schema, ctx) as string;
    if (a !== b) {
      allMatch = false;
      // print a small unified diff-like output
      console.log(`DIFF for ${path.relative(examplesDir, p)}`);
      const al = a.split("\n");
      const bl = b.split("\n");
      const n = Math.max(al.length, bl.length);
      for (let i = 0; i < n; i++) {
        if (al[i] !== bl[i]) {
          console.log(`- ${al[i] ?? ""}`);
          console.log(`+ ${bl[i] ?? ""}`);
          break;
        }
      }
    } else {
      console.log(`OK ${path.relative(examplesDir, p)}`);
    }
  }
  if (!allMatch) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
