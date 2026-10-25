#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAuditScope } from "../../../../tools/docs-audit/DocsAudit.mjs";
import { createRuntime, pathExists, repoRoot } from "../../../../tools/docs-audit/AuditRuntime.mjs";

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
  return {
    Scope: scope,
    ProjectRoot: discovered.docRoot,
    InGit: discovered.inGit,
    FileListRule: isFile ? "file" : discovered.scanMode,
    ExcludePatterns: discovered.effectiveExcludes,
    ArticleTypeGuide: path.join(specificationsDirectory, "agent写作备忘.md"),
    Specifications: {
      General: path.join(specificationsDirectory, "通用写作规范.md"),
      CurrentState: path.join(specificationsDirectory, "当前状态文档写作规范.md"),
      SemanticChecklist: path.join(specificationsDirectory, "中文技术写作语义审校清单.md"),
    },
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
