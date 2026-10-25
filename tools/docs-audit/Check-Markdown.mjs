// Read-only Prettier checks from an explicit JSON inventory.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as prettier from "./node_modules/prettier/index.mjs";
import { resolveAuditConfiguration } from "./PrettierConfiguration.mjs";

try {
  const request = JSON.parse((await fs.readFile(process.argv[2], "utf8")).replace(/^\uFEFF/, ""));
  const records = [];
  for (const entry of request.Files) {
    const started = performance.now();
    let status = "PASS";
    let error = "";
    let configuration = null;
    try {
      const source = path.resolve(entry.Source);
      configuration = await resolveAuditConfiguration(source, request);
      const info = await prettier.getFileInfo(source, { ignorePath: request.IgnorePath, resolveConfig: false });
      if (!info.ignored) {
        const text = await fs.readFile(source, "utf8");
        if (!(await prettier.check(text, configuration.Options))) status = "FAIL";
      }
    } catch (failure) {
      status = "ERROR";
      error = String(failure.stack ?? failure);
    }
    records.push({ File: entry.File, Status: status, Error: error, Configuration: configuration, DurationMs: performance.now() - started });
  }
  process.stdout.write(JSON.stringify(records));
  process.exitCode = records.some((record) => record.Status === "ERROR") ? 2 : records.some((record) => record.Status === "FAIL") ? 1 : 0;
} catch (failure) {
  process.stderr.write(String(failure.stack ?? failure));
  process.exitCode = 2;
}
