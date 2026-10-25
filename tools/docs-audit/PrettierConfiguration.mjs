import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as prettier from "./node_modules/prettier/index.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};

export async function resolveAuditConfiguration(source, request) {
  const options = { ...(await prettier.resolveConfig(source, { config: request.Config, editorconfig: true })), filepath: source };
  const files = new Set([path.resolve(request.Config), path.resolve(request.IgnorePath)]);
  for (const plugin of options.plugins ?? []) if (typeof plugin === "string" && path.isAbsolute(plugin)) files.add(plugin);
  // Record EditorConfig inputs as well as the resolved effective options.
  for (let directory = path.dirname(source); ; directory = path.dirname(directory)) {
    const editorConfig = path.join(directory, ".editorconfig");
    try {
      const text = await fs.readFile(editorConfig, "utf8");
      files.add(editorConfig);
      if (/^\s*root\s*=\s*true\s*(?:[#;].*)?$/im.test(text)) break;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path.dirname(directory) === directory) break;
  }
  const dependencies = [];
  for (const file of [...files].sort()) dependencies.push({ Path: file, Sha256: sha256(await fs.readFile(file)) });
  const configuration = { PrettierVersion: prettier.version, EditorConfigEnabled: true, Options: options, Files: dependencies };
  configuration.Fingerprint = sha256(JSON.stringify(canonical(configuration)));
  return configuration;
}
