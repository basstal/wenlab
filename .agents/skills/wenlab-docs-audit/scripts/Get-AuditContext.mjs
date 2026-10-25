#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAuditScope,
  getEffectiveExcludes,
  matchesExclude,
} from "../../../../tools/docs-audit/DocsAudit.mjs";
import {
  createRuntime,
  pathExists,
  repoRoot,
  toPosixRelative,
} from "../../../../tools/docs-audit/AuditRuntime.mjs";

const markerNames = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "composer.json",
  "Gemfile",
  "project.godot",
  "ProjectVersion.txt",
]);
const markerPatterns = ["*.sln", "*.csproj", "*.uproject"];

function parse(argv) {
  const options = { Path: null, WenlabRoot: repoRoot, Help: false };
  const names = new Map([
    ["path", "Path"],
    ["wenlabroot", "WenlabRoot"],
    ["wenlab-root", "WenlabRoot"],
    ["help", "Help"],
    ["h", "Help"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equal = token.indexOf("=");
    const raw = equal >= 0 ? token.slice(0, equal) : token;
    const key = names.get(raw.replace(/^--?/, "").toLowerCase());
    if (!key) throw new Error(`Unknown option: ${raw}`);
    if (key === "Help") {
      options.Help = true;
      continue;
    }
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (value === undefined) throw new Error(`Option ${raw} requires a value.`);
    options[key] = value;
  }
  return options;
}

function isMarker(name) {
  return markerNames.has(name) || markerPatterns.some((pattern) => path.matchesGlob(name, pattern));
}

async function findEngineeringEvidence(root, configRoot, projectConfig) {
  const excludes = getEffectiveExcludes(projectConfig);
  const evidence = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length && evidence.length < 10) {
    const { directory, depth } = pending.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = toPosixRelative(path.relative(root, full));
      if (
        relative.toLowerCase() === ".git" ||
        relative.toLowerCase().startsWith(".git/") ||
        entry.name.toLowerCase() === "node_modules"
      ) {
        continue;
      }
      if (matchesExclude(relative, excludes, { isDirectory: entry.isDirectory() })) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && isMarker(entry.name)) evidence.push(relative);
      if (entry.isDirectory() && depth < 2) pending.push({ directory: full, depth: depth + 1 });
      if (evidence.length >= 10) break;
    }
  }
  return evidence;
}

export async function getAuditContext({ scopePath, wenlabRoot = repoRoot }) {
  const specificationsDirectory = path.join(wenlabRoot, "docs");
  if (!(await pathExists(path.join(specificationsDirectory, "通用写作规范.md"), "file"))) {
    throw new Error(
      `wenlab writing specifications not found under ${specificationsDirectory}; pass -WenlabRoot.`,
    );
  }
  const runtime = createRuntime();
  const reportRoot = path.join(repoRoot, ".tmp", "docs-audit");
  const scope = path.isAbsolute(scopePath) ? path.resolve(scopePath) : path.resolve(process.cwd(), scopePath);
  if (!(await pathExists(scope))) throw new Error(`Path not found: ${scope}`);
  const isFile = await pathExists(scope, "file");
  const scopeDirectory = isFile ? path.dirname(scope) : scope;
  const discovered = await discoverAuditScope({
    scopePath: scope,
    reportRoot,
    runtime,
  });
  const evidence = await findEngineeringEvidence(
    discovered.docRoot,
    runtime.configRoot,
    discovered.projectConfig,
  );
  const applied = [path.join(specificationsDirectory, "通用写作规范.md")];
  if (evidence.length) applied.push(path.join(specificationsDirectory, "当前状态文档写作规范.md"));
  return {
    Scope: scope,
    ProjectRoot: discovered.docRoot,
    InGit: discovered.inGit,
    FileListRule: isFile ? "file" : discovered.scanMode,
    ProjectType: evidence.length ? "engineering" : "general",
    ProjectEvidence: evidence,
    ExcludePatterns: discovered.effectiveExcludes,
    Specifications: applied,
    QualityLayers: path.join(specificationsDirectory, "agent写作备忘.md"),
    SemanticChecklist: path.join(specificationsDirectory, "中文技术写作语义审校清单.md"),
    MarkdownCount: discovered.files.length,
    MarkdownFiles: discovered.files,
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.Help || !options.Path) {
    console.log(
      "Usage: node Get-AuditContext.mjs -Path <file-or-directory> [-WenlabRoot <directory>]",
    );
    return options.Help ? 0 : 2;
  }
  const result = await getAuditContext({
    scopePath: options.Path,
    wenlabRoot: path.resolve(options.WenlabRoot),
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    process.exitCode = await main();
  } catch (failure) {
    console.error(`[ERROR] ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 2;
  }
}
