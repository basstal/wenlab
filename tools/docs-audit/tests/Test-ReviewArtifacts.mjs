import fs from "node:fs/promises";
import path from "node:path";
import { invokeDocsAudit } from "../DocsAudit.mjs";
import {
  assert,
  assertEqual,
  cleanupTempProject,
  createTempProject,
  latestRun,
  latestSummary,
  repoRoot,
  run,
  testReportPath,
  writeFile,
} from "./TestSupport.mjs";

const { project, id } = await createTempProject("wenlab-audit-review");
const dummyBeyondCompare = path.join(project, "BCompare.exe");
await writeFile(dummyBeyondCompare, "not executable; CheckOnly only verifies its path");

async function checkSubmission(runDirectory, expectedCode = 0) {
  const result = await run(
    process.execPath,
    [
      path.join(runDirectory, "Open-Comparison.mjs"),
      "-RunDirectory",
      runDirectory,
      "-BeyondComparePath",
      dummyBeyondCompare,
      "-CheckOnly",
    ],
    { cwd: runDirectory },
  );
  assertEqual(result.code, expectedCode, `Open-Comparison CheckOnly: ${result.stderr}`);
  return result;
}

try {
  const directoryScope = path.join(project, "directory-scope");
  await writeFile(
    path.join(directoryScope, "index.md"),
    "# Title\n\n-   first item\n\nText.\n",
  );
  await writeFile(
    path.join(directoryScope, "中文 子目录", "中文.md"),
    "# 中文\n\n正文。\n",
  );

  const directoryReports = testReportPath("directory");
  const directoryCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: directoryScope,
    reportDirectory: directoryReports,
    profiler: true,
  });
  assertEqual(directoryCode, 1, "Formatting problem should return exit 1");
  const firstRun = await latestRun(path.join(directoryReports, "LocalGate"));
  const firstSummary = await latestSummary(path.join(directoryReports, "LocalGate"));
  assertEqual(firstSummary.summary.Review.Status, "READY", "Review artifacts should be ready");
  assertEqual(firstSummary.summary.Files.length, 2, "Directory scope file count");
  assert(firstSummary.summary.Profile.Enabled, "Profiler should be enabled");
  assertEqual(
    firstSummary.summary.Profile.Calls.filter((call) => call.Phase === "preview-batch").length,
    1,
    "All previews should share one Node process",
  );
  for (const relative of ["index.md", path.join("中文 子目录", "中文.md")]) {
    assert(
      await fs.stat(path.join(firstRun, "repair-preview", relative)).then(
        () => true,
        () => false,
      ),
      `Missing preview for ${relative}`,
    );
  }
  const manifest = JSON.parse(await fs.readFile(path.join(firstRun, "comparison.json"), "utf8"));
  assertEqual(manifest.NameFilters, "*.md", "Directory comparison filter");
  assertEqual(manifest.Files.length, 2, "Comparison manifest file count");
  assert(
    await fs.stat(path.join(firstRun, "Open-Comparison.mjs")).then(
      () => true,
      () => false,
    ),
    "Copied comparison launcher is missing.",
  );
  assert(firstSummary.diagnosis.includes("node '"), "Rerun command should use Node.js");
  assert(
    firstSummary.diagnosis.includes(path.join(repoRoot, "tools", "docs-audit", "LocalGate.mjs")),
    "Rerun command should point to LocalGate.mjs.",
  );
  await checkSubmission(firstRun);
  console.log("PASS: directory review artifacts, previews and Node rerun command");

  const secondCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: directoryScope,
    reportDirectory: directoryReports,
  });
  assertEqual(secondCode, 1, "Second formatting run should still fail");
  const runs = (await fs.readdir(path.join(directoryReports, "LocalGate"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assertEqual(runs.length, 2, "Repeated runs must use independent report directories");
  console.log("PASS: repeated runs do not overwrite prior review artifacts");

  await writeFile(path.join(directoryScope, "index.md"), "# Title\n\n- item\n\nChanged.\n");
  const stale = await checkSubmission(firstRun, 1);
  assert(
    stale.stderr.includes("原文已变化"),
    "Stale preview must be rejected after source edits.",
  );
  console.log("PASS: edited source rejects a stale comparison");

  const singleFile = path.join(project, "single.markdown");
  await writeFile(singleFile, "# Single\n\nText.\n");
  const singleReports = testReportPath("single");
  const singleCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: singleFile,
    reportDirectory: singleReports,
  });
  assertEqual(singleCode, 0, "Single .markdown file should pass");
  const singleRun = await latestRun(path.join(singleReports, "LocalGate"));
  const singleManifest = JSON.parse(
    await fs.readFile(path.join(singleRun, "comparison.json"), "utf8"),
  );
  assertEqual(singleManifest.NameFilters, "single.markdown", "Single-file comparison filter");
  await checkSubmission(singleRun);
  console.log("PASS: a single .markdown file uses its exact comparison filter");

  const archiveScope = path.join(project, "archive-scope");
  await writeFile(
    path.join(archiveScope, "current.md"),
    "# Current\n\nSee [old](ARCHIVE/old.md).\n",
  );
  await writeFile(path.join(archiveScope, "ARCHIVE", "old.md"), "# Old\n\nText.\n");
  await writeFile(
    path.join(archiveScope, ".wenlab", "docs-audit.json"),
    JSON.stringify({ exclude: ["archive"], archiveLinks: { directoryNames: ["archive"] } }),
  );
  const archiveReports = testReportPath("archive-links");
  const archiveCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: archiveScope,
    reportDirectory: archiveReports,
  });
  assertEqual(archiveCode, 0, "Archived targets should not fail an otherwise valid scope");
  const archive = await latestSummary(path.join(archiveReports, "LocalGate"));
  assertEqual(
    archive.summary.Files.join(","),
    "current.md",
    "Archive directories must be excluded from the audit inventory",
  );
  assertEqual(archive.summary.ArchiveLinks.length, 1, "Archive link should be reported");
  assert(
    archive.diagnosis.includes("## 对归档文档的链接引用") &&
      archive.diagnosis.includes("ARCHIVE/old.md"),
    "Diagnosis should list the archive link.",
  );
  console.log("PASS: archive links are reported without auditing archived documents");

  const relativeScope = path.join(project, "relative-scope");
  await writeFile(path.join(relativeScope, "note.md"), "# Note\n\nText.\n");
  const relativeReports = testReportPath("relative-path");
  const relative = await run(
    process.execPath,
    [
      path.join(repoRoot, "tools", "docs-audit", "LocalGate.mjs"),
      "-Path",
      ".",
      "-ReportDirectory",
      relativeReports,
    ],
    { cwd: relativeScope },
  );
  assertEqual(relative.code, 0, `Relative -Path failed: ${relative.stderr}`);
  const relativeSummary = await latestSummary(path.join(relativeReports, "LocalGate"));
  assertEqual(relativeSummary.summary.Scope, relativeScope, "Relative -Path should use the caller CWD");
  assertEqual(relativeSummary.summary.Files.join(","), "note.md", "Relative scope inventory");
  console.log("PASS: an explicit relative -Path resolves against the caller's working directory");
} finally {
  await cleanupTempProject(project, "wenlab-audit-review", id);
}

console.log("Review artifact tests PASS.");
