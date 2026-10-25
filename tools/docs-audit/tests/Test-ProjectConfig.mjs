import fs from "node:fs/promises";
import path from "node:path";
import { invokeDocsAudit } from "../DocsAudit.mjs";
import {
  assert,
  assertEqual,
  cleanupTempProject,
  createTempProject,
  initGit,
  latestSummary,
  repoRoot,
  run,
  writeFile,
} from "./TestSupport.mjs";

const { project, id } = await createTempProject("wenlab-audit-config");
const output = path.join(repoRoot, ".tmp", "docs-audit", "node-tests", "config", id);
const configPath = path.join(project, ".wenlab", "docs-audit.json");

async function invokeCase(name, scope = path.join(project, "docs")) {
  const code = await invokeDocsAudit({
    gate: "LocalGate",
    path: scope,
    reportDirectory: path.join(output, name),
  });
  const reportRoot = path.join(output, name, "LocalGate");
  return { code, ...(await latestSummary(reportRoot)) };
}

function getStatus(summary, tool) {
  return summary.Results.find((result) => result.Tool === tool)?.Status;
}

try {
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.mkdir(path.join(project, ".wenlab"), { recursive: true });
  await initGit(project);
  await writeFile(path.join(project, ".wenlab", "dictionary.txt"), "Readme\nKeep\nNothing\n");
  await writeFile(
    path.join(project, "docs", "readme.md"),
    "# Readme\n\n**Overview**\n\nSee [the code](../src/app.cs).\n",
  );
  await writeFile(path.join(project, "docs", "zh.md"), '# 说明\n\n核心是"友好"。\n');
  await writeFile(path.join(project, "docs", "archive", "old.md"), "# Old\n\nNothing here.\n");

  const none = await invokeCase("none");
  assertEqual(none.code, 1, "Default rules should fail the sample project");
  assertEqual(getStatus(none.summary, "rumdl"), "FAIL", "MD036 should fail without overrides");
  assertEqual(getStatus(none.summary, "lychee-local"), "FAIL", "Missing link should fail");
  assertEqual(getStatus(none.summary, "vale"), "FAIL", "Half-width quotes should fail");
  assert(!none.summary.ProjectConfig.Found, "No project config should be reported as found.");
  assert(!none.diagnosis.includes("MD057"), "MD057 is disabled and must not be reported.");
  assertEqual(getStatus(none.summary, "filenames"), "PASS", "Default file name check should pass.");
  assert(
    none.summary.Files.includes("docs/archive/old.md"),
    "archive must be audited when exclude does not list it",
  );
  console.log("PASS: without .wenlab/docs-audit.json the default rules apply");
  console.log("PASS: archive is audited unless the project exclude list names it");

  const defaultContext = await run(process.execPath, [
    path.join(repoRoot, ".agents", "skills", "wenlab-docs-audit", "scripts", "Get-AuditContext.mjs"),
    "-Path",
    path.join(project, "docs"),
  ]);
  assertEqual(defaultContext.code, 0, `Default audit context failed: ${defaultContext.stderr}`);
  const defaultContextJson = JSON.parse(defaultContext.stdout);
  assert(
    defaultContextJson.MarkdownFiles.includes("docs/archive/old.md"),
    "Audit context must include archive when exclude is absent",
  );
  assertEqual(
    defaultContextJson.ExcludePatterns.length,
    0,
    "Audit context must not add a default exclusion",
  );
  console.log("PASS: audit context has no built-in archive exclusion");

  const overrides = {
    rumdl: { disable: ["MD036"] },
    lychee: { exclude: ["/src/"] },
    vale: { disable: ["Wenlab.Quotes"] },
  };
  await writeFile(configPath, JSON.stringify(overrides));
  const configured = await invokeCase("configured");
  assertEqual(configured.code, 0, "Overrides should allow the sample project");
  assert(configured.summary.ProjectConfig.Found, "Project config should be reported as found.");
  assert(configured.summary.ProjectConfig.RumdlDisable.includes("MD036"), "MD036 override was lost.");
  assert(
    configured.summary.ProjectConfig.ValeDisable.includes("Wenlab.Quotes"),
    "Vale override was lost.",
  );
  assert(configured.diagnosis.includes("MD036"), "Diagnosis omits the MD036 override.");
  assert(configured.diagnosis.includes("/src/"), "Diagnosis omits the lychee exclusion.");
  assert(configured.diagnosis.includes("Wenlab.Quotes"), "Diagnosis omits the Vale override.");
  console.log("PASS: .wenlab/docs-audit.json applies rumdl, lychee and Vale overrides");

  const badNames = [
    "docs/User_Guide.md",
    "docs/中文 名.md",
    "docs/说明（草稿）.md",
    "docs/a&b.md",
    "docs/AGENTS.md-编写规范.md",
  ];
  const goodNames = ["docs/CHANGELOG.md", "docs/中文-Guide.md", "docs/AGENTS-md-编写规范.md"];
  for (const name of [...badNames, ...goodNames]) {
    await writeFile(path.join(project, name), "# Notes\n\nNone.\n");
  }
  try {
    const named = await invokeCase("filenames");
    assertEqual(named.code, 1, "Bad file names should fail");
    const nameResult = named.summary.Results.find((result) => result.Tool === "filenames");
    const reported = nameResult.Findings.map((finding) => finding.File).sort();
    assertEqual(reported.join(","), [...badNames].sort().join(","), "File name check mismatch");
    for (const name of badNames) assert(named.diagnosis.includes(name), `Diagnosis omits ${name}.`);
    await writeFile(
      configPath,
      JSON.stringify({ ...overrides, fileNames: { enabled: false } }),
    );
    const off = await invokeCase("filenames-off");
    assertEqual(off.code, 0, "Disabling file name checks should pass the sample");
    assert(
      !off.summary.Results.some((result) => result.Tool === "filenames"),
      "fileNames.enabled false should skip the check.",
    );
    assert(off.diagnosis.includes("文件名检查：未启用"), "Diagnosis should show file names disabled.");
  } finally {
    for (const name of [...badNames, ...goodNames]) {
      await fs.rm(path.join(project, name), { force: true });
    }
  }
  console.log("PASS: the file name check runs by default and can be disabled");

  const exclusionRoot = path.join(project, "docs", "exclusions");
  await writeFile(path.join(exclusionRoot, "keep.md"), "# Keep\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "archive", "old.md"), "# Old\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "private", "secret.md"), "# Secret\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "drafts-a", "draft.md"), "# Draft\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "notes", "ignored.tmp.md"), "# Ignored\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "path", "to", "ignored.md"), "# Ignored\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "path", "to", "keep.md"), "# Keep\n\nNothing here.\n");
  await writeFile(path.join(exclusionRoot, "generated", "inside.md"), "# Generated\n\nNothing here.\n");
  await writeFile(
    configPath,
    JSON.stringify({
      exclude: [
        "archive",
        "private",
        "drafts-*",
        "**/*.tmp.md",
        "docs/exclusions/path/to/ignored.md",
        "docs/exclusions/generated",
      ],
    }),
  );
  const excluded = await invokeCase("excluded", exclusionRoot);
  assertEqual(excluded.code, 0, "Excluded sample should pass");
  assertEqual(
    excluded.summary.Files.join(","),
    "docs/exclusions/keep.md,docs/exclusions/path/to/keep.md",
    "Exclude name, path and wildcard rules did not filter the expected files",
  );
  assert(excluded.diagnosis.includes("drafts-*"), "Diagnosis omits configured exclusions.");
  console.log("PASS: exclude entries support names, paths, * and **");

  const directArchive = await invokeCase("direct-archive", path.join(exclusionRoot, "archive"));
  assertEqual(directArchive.code, 0, "Direct archive scope should be audited");
  assertEqual(
    directArchive.summary.Files.join(","),
    "docs/exclusions/archive/old.md",
    "Direct archive scope must override the inherited archive exclusion",
  );
  console.log("PASS: an explicitly selected archive directory is still audited");

  const context = await run(process.execPath, [
    path.join(repoRoot, ".agents", "skills", "wenlab-docs-audit", "scripts", "Get-AuditContext.mjs"),
    "-Path",
    exclusionRoot,
  ]);
  assertEqual(context.code, 0, `Audit context failed: ${context.stderr}`);
  const contextJson = JSON.parse(context.stdout);
  assertEqual(
    contextJson.MarkdownFiles.join(","),
    "docs/exclusions/keep.md,docs/exclusions/path/to/keep.md",
    "Audit context did not apply the project exclusions",
  );
  assertEqual(
    contextJson.ExcludePatterns.join(","),
    "archive,private,drafts-*,**/*.tmp.md,docs/exclusions/path/to/ignored.md,docs/exclusions/generated",
    "Audit context did not report the effective exclusions",
  );
  console.log("PASS: audit context applies the same exclusions as the Gate");

  const archiveLinkRoot = path.join(project, "docs", "archive-links");
  await writeFile(
    path.join(archiveLinkRoot, "current.md"),
    "# Current\n\nSee [old](history/old.md) and [older](archive/older.md).\n",
  );
  await writeFile(path.join(archiveLinkRoot, "history", "old.md"), "# Old\n\nNothing here.\n");
  await writeFile(path.join(archiveLinkRoot, "archive", "older.md"), "# Older\n\nNothing here.\n");
  const archiveExclude = ["history", "archive"];
  const linkTargets = (summary) => summary.ArchiveLinks.map((link) => link.Target).join(",");

  await writeFile(configPath, JSON.stringify({ exclude: archiveExclude }));
  const unnamedArchive = await invokeCase("archive-links-unnamed", archiveLinkRoot);
  assertEqual(unnamedArchive.code, 0, "Unnamed archive link sample should pass");
  assert(unnamedArchive.summary.ProjectConfig.ArchiveLinks.Enabled, "Archive links should default to enabled.");
  assertEqual(unnamedArchive.summary.ArchiveLinks.length, 0, "No archive name must not list links");
  assert(!unnamedArchive.summary.ArchiveLinksScanned, "No archive name must not scan links.");
  assert(
    unnamedArchive.diagnosis.includes("未指定 `archiveLinks.directoryNames`"),
    "Diagnosis should say no archive directory name is configured.",
  );
  console.log("PASS: archive links are not identified without archiveLinks.directoryNames");

  await writeFile(
    configPath,
    JSON.stringify({ exclude: archiveExclude, archiveLinks: { directoryNames: ["History"] } }),
  );
  const namedArchive = await invokeCase("archive-links-named", archiveLinkRoot);
  assertEqual(namedArchive.code, 0, "Named archive link sample should pass");
  assertEqual(linkTargets(namedArchive.summary), "history/old.md", "Configured archive directory name");
  assert(namedArchive.diagnosis.includes("history/old.md"), "Diagnosis omits the configured archive link.");
  assert(namedArchive.diagnosis.includes("History"), "Diagnosis omits the configured archive name.");
  console.log("PASS: archiveLinks.directoryNames selects the archive directories");

  await writeFile(
    configPath,
    JSON.stringify({ exclude: archiveExclude, archiveLinks: { enabled: false, directoryNames: ["history"] } }),
  );
  const offArchive = await invokeCase("archive-links-off", archiveLinkRoot);
  assertEqual(offArchive.code, 0, "Disabled archive link sample should pass");
  assertEqual(offArchive.summary.ArchiveLinks.length, 0, "Disabled archive check must not list links");
  assert(!offArchive.summary.ArchiveLinksScanned, "Disabled archive check must not scan links.");
  assert(offArchive.diagnosis.includes("归档链接检查：未启用"), "Diagnosis should show archive links disabled.");
  assertEqual(
    offArchive.summary.Files.join(","),
    "docs/archive-links/current.md",
    "Disabling the archive link check must not change exclude rules",
  );
  console.log("PASS: archiveLinks.enabled false skips the scan without changing exclude rules");
  await fs.rm(archiveLinkRoot, { recursive: true, force: true });

  const invalidConfigs = [
    '{ "rumdl": { "disable": ["NOPE"] } }',
    '{ "prettier": {} }',
    '{ "lychee": { "exclude": ["("] } }',
    "{ not json",
    '{ "vale": { "disable": ["Wenlab.Nope"] } }',
    '{ "vale": { "disable": ["MD036"] } }',
    '{ "fileNames": { "enabled": "yes" } }',
    '{ "fileNames": { "other": true } }',
    '{ "archiveLinks": { "enabled": "yes" } }',
    '{ "archiveLinks": { "other": true } }',
    '{ "archiveLinks": { "directoryNames": "archive" } }',
    '{ "archiveLinks": { "directoryNames": [] } }',
    '{ "archiveLinks": { "directoryNames": ["docs/archive"] } }',
    '{ "archiveLinks": { "directoryNames": [".."] } }',
    '{ "exclude": "archive" }',
    '{ "exclude": [""] }',
    '{ "exclude": ["C:/outside"] }',
    '{ "exclude": ["docs/../outside"] }',
  ];
  for (let index = 0; index < invalidConfigs.length; index += 1) {
    await writeFile(configPath, invalidConfigs[index]);
    const invalid = await invokeCase(`invalid-${index + 1}`);
    assertEqual(invalid.code, 2, `Invalid config did not fail closed: ${invalidConfigs[index]}`);
    const orchestrator = invalid.summary.Results.find((result) => result.Tool === "orchestrator");
    assert(
      orchestrator?.Message?.includes("project audit config"),
      `Invalid config message is missing: ${invalidConfigs[index]}`,
    );
  }
  console.log("PASS: invalid .wenlab/docs-audit.json values return ERROR");
} finally {
  await cleanupTempProject(project, "wenlab-audit-config", id);
}

console.log("Project config tests PASS.");
