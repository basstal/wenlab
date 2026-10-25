// Formats only the explicit preview destinations; never writes source documents.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as prettier from "./node_modules/prettier/index.mjs";
import { resolveAuditConfiguration, sha256 } from "./PrettierConfiguration.mjs";

try {
  const request = JSON.parse((await fs.readFile(process.argv[2], "utf8")).replace(/^\uFEFF/, ""));
  const previewRoot = path.resolve(request.PreviewRoot);
  const records = [];
  for (const entry of request.Files) {
    const started = performance.now();
    const source = path.resolve(entry.Source);
    const target = path.resolve(entry.Target);
    const relative = path.relative(previewRoot, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || source === target) {
      throw new Error(`Invalid preview destination: ${target}`);
    }
    const original = await fs.readFile(source);
    let formatted = original;
    let status = "FORMATTED";
    let error = "";
    let configuration = null;
    let secondPassPerformed = false;
    let stability = null;
    try {
      configuration = await resolveAuditConfiguration(source, request);
      if (entry.ExpectedFingerprint && entry.ExpectedFingerprint !== configuration.Fingerprint) {
        status = "CONFIGURATION_MISMATCH";
        throw new Error("Check and preview configuration fingerprints differ; rerun the Gate.");
      }
      const info = await prettier.getFileInfo(source, { ignorePath: request.IgnorePath, resolveConfig: false });
      if (!info.ignored) {
        const text = original.toString("utf8");
        const first = await prettier.format(text, configuration.Options);
        formatted = first;
        if (first !== text) {
          secondPassPerformed = true;
          const second = await prettier.format(first, configuration.Options);
          if (first !== second) {
            status = "UNSTABLE_FORMAT";
            error = "F(x) differs from F(F(x)); repair preview retains the original.";
            const diagnosticRoot = path.join(path.dirname(previewRoot), "format-stability");
            await fs.mkdir(diagnosticRoot, { recursive: true });
            const prefix = String(records.length + 1).padStart(4, "0");
            const firstPath = path.join(diagnosticRoot, `${prefix}-y.md`);
            const secondPath = path.join(diagnosticRoot, `${prefix}-z.md`);
            if ([firstPath, secondPath].includes(source)) throw new Error("Diagnostic destination overlaps a source.");
            await fs.writeFile(firstPath, first);
            await fs.writeFile(secondPath, second);
            stability = { FirstSha256: sha256(first), SecondSha256: sha256(second), Y: `format-stability/${prefix}-y.md`, Z: `format-stability/${prefix}-z.md` };
            formatted = original;
          }
        }
      }
    } catch (failure) {
      if (status !== "CONFIGURATION_MISMATCH") status = "UNCHANGED_FORMAT_ERROR";
      error = String(failure.stack ?? failure);
      formatted = original;
    }
    await fs.writeFile(target, formatted);
    records.push({ File: entry.File, PreviewStatus: status, Error: error, Configuration: configuration, SecondPassPerformed: secondPassPerformed, Stability: stability, DurationMs: performance.now() - started });
  }
  process.stdout.write(JSON.stringify(records));
} catch (failure) {
  process.stderr.write(String(failure.stack ?? failure));
  process.exitCode = 2;
}
