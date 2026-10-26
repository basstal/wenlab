import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  appendLog,
  createRuntime,
  isPathInside,
  packageRoot,
  pathExists,
  readJson,
  sha256File,
  stripAnsi,
  toPosixRelative,
  writeJson,
} from "./AuditRuntime.mjs";
import { getAutoCorrectFindings, getCSpellFindings } from "./Findings.mjs";
import { createReviewArtifacts, writeAuditDiagnosis } from "./ReviewArtifacts.mjs";

export { getAutoCorrectFindings, getCSpellFindings };

const skippedDirectoryNames = new Set([".git", "node_modules"]);
const markdownExtensions = new Set([".md", ".markdown"]);

function normalizeExcludePattern(value) {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function globMatches(candidate, pattern) {
  try {
    return path.matchesGlob(candidate.toLowerCase(), pattern.toLowerCase());
  } catch {
    return false;
  }
}

export function matchesExclude(relativePath, patterns, { isDirectory = false } = {}) {
  const target = normalizeExcludePattern(relativePath);
  if (!target || target === ".") return false;
  const segments = target.split("/").filter(Boolean);
  const ancestors = [];
  for (let index = segments.length; index > 0; index -= 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  if (!isDirectory) ancestors.shift();

  for (const rawPattern of patterns ?? []) {
    const pattern = normalizeExcludePattern(rawPattern);
    if (!pattern) continue;
    if (!pattern.includes("/")) {
      if (segments.some((segment) => globMatches(segment, pattern))) return true;
      continue;
    }
    if (globMatches(target, pattern)) return true;
    if (ancestors.some((candidate) => globMatches(candidate, pattern))) return true;
  }
  return false;
}

export function getEffectiveExcludes(projectConfig) {
  return [...new Set((projectConfig?.Exclude ?? []).map(normalizeExcludePattern))];
}

function applyScopeExcludeOverride(scope, docRoot, patterns, scopeIsDirectory) {
  if (!scopeIsDirectory) return [];
  const relative = toPosixRelative(path.relative(docRoot, scope));
  if (!relative || relative === ".") return patterns;
  const probe = `${relative}/__wenlab_scope_probe__`;
  return patterns.filter(
    (pattern) =>
      !matchesExclude(relative, [pattern], { isDirectory: true }) &&
      !matchesExclude(probe, [pattern]),
  );
}

function buildExcludeRegex(pattern, configPath) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(
      `Invalid project audit config ${configPath}: lychee.exclude '${pattern}' is not a valid regular expression.`,
    );
  }
}

export async function readProjectAuditConfig(configPath, runtimeConfigRoot) {
  const config = {
    Path: configPath,
    Found: false,
    Exclude: [],
    RumdlDisable: [],
    LycheeExclude: [],
    ValeDisable: [],
    FileNames: true,
    ArchiveLinks: { Enabled: true, DirectoryNames: [] },
  };
  if (!(await pathExists(configPath, "file"))) return config;
  config.Found = true;

  let data;
  try {
    data = await readJson(configPath);
  } catch {
    throw new Error(`Invalid project audit config ${configPath}: not valid JSON.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid project audit config ${configPath}: the top level must be an object.`);
  }
  for (const key of Object.keys(data)) {
    if (!["exclude", "rumdl", "lychee", "vale", "fileNames", "archiveLinks"].includes(key)) {
      throw new Error(`Invalid project audit config ${configPath}: unsupported key '${key}'.`);
    }
    if (key !== "exclude" && (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key]))) {
      throw new Error(`Invalid project audit config ${configPath}: '${key}' must be an object.`);
    }
  }

  if (Object.hasOwn(data, "exclude")) {
    if (!Array.isArray(data.exclude)) {
      throw new Error(`Invalid project audit config ${configPath}: 'exclude' must be an array.`);
    }
    for (const entry of data.exclude) {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new Error(
          `Invalid project audit config ${configPath}: exclude entries must be non-empty strings.`,
        );
      }
      const normalized = normalizeExcludePattern(entry);
      if (
        !normalized ||
        path.isAbsolute(entry) ||
        /^[A-Za-z]:[\\/]/.test(entry) ||
        normalized.startsWith("/") ||
        normalized.split("/").includes("..")
      ) {
        throw new Error(
          `Invalid project audit config ${configPath}: exclude entry '${entry}' must be a relative directory name, file path, or wildcard pattern.`,
        );
      }
      try {
        path.matchesGlob("probe", normalized);
      } catch {
        throw new Error(
          `Invalid project audit config ${configPath}: exclude entry '${entry}' is not a valid wildcard pattern.`,
        );
      }
      config.Exclude.push(normalized);
    }
    config.Exclude = [...new Set(config.Exclude)];
  }

  if (Object.hasOwn(data, "rumdl")) {
    for (const key of Object.keys(data.rumdl)) {
      if (key !== "disable") {
        throw new Error(`Invalid project audit config ${configPath}: unsupported key 'rumdl.${key}'.`);
      }
    }
    if (Object.hasOwn(data.rumdl, "disable")) {
      if (!Array.isArray(data.rumdl.disable)) {
        throw new Error(`Invalid project audit config ${configPath}: 'rumdl.disable' must be an array.`);
      }
      for (const rule of data.rumdl.disable) {
        if (typeof rule !== "string" || !/^MD\d{3}$/.test(rule)) {
          throw new Error(
            `Invalid project audit config ${configPath}: rumdl.disable entry '${rule}' is not a rule such as MD036.`,
          );
        }
        config.RumdlDisable.push(rule);
      }
    }
  }

  if (Object.hasOwn(data, "lychee")) {
    for (const key of Object.keys(data.lychee)) {
      if (key !== "exclude") {
        throw new Error(`Invalid project audit config ${configPath}: unsupported key 'lychee.${key}'.`);
      }
    }
    if (Object.hasOwn(data.lychee, "exclude")) {
      if (!Array.isArray(data.lychee.exclude)) {
        throw new Error(`Invalid project audit config ${configPath}: 'lychee.exclude' must be an array.`);
      }
      for (const pattern of data.lychee.exclude) {
        if (typeof pattern !== "string" || !pattern) {
          throw new Error(
            `Invalid project audit config ${configPath}: lychee.exclude entries must be non-empty strings.`,
          );
        }
        buildExcludeRegex(pattern, configPath);
        config.LycheeExclude.push(pattern);
      }
    }
  }

  if (Object.hasOwn(data, "vale")) {
    for (const key of Object.keys(data.vale)) {
      if (key !== "disable") {
        throw new Error(`Invalid project audit config ${configPath}: unsupported key 'vale.${key}'.`);
      }
    }
    if (Object.hasOwn(data.vale, "disable")) {
      if (!Array.isArray(data.vale.disable)) {
        throw new Error(`Invalid project audit config ${configPath}: 'vale.disable' must be an array.`);
      }
      for (const rule of data.vale.disable) {
        const styleName = typeof rule === "string" ? rule.substring(7) : "";
        const stylePath = path.join(runtimeConfigRoot, "styles", "Wenlab", `${styleName}.yml`);
        if (
          typeof rule !== "string" ||
          !/^Wenlab\.[A-Za-z]+$/.test(rule) ||
          !(await pathExists(stylePath, "file"))
        ) {
          throw new Error(
            `Invalid project audit config ${configPath}: vale.disable entry '${rule}' is not a Wenlab Vale rule such as Wenlab.Quotes.`,
          );
        }
        config.ValeDisable.push(rule);
      }
    }
  }

  if (Object.hasOwn(data, "fileNames")) {
    for (const key of Object.keys(data.fileNames)) {
      if (key !== "enabled") {
        throw new Error(`Invalid project audit config ${configPath}: unsupported key 'fileNames.${key}'.`);
      }
    }
    if (Object.hasOwn(data.fileNames, "enabled")) {
      if (typeof data.fileNames.enabled !== "boolean") {
        throw new Error(
          `Invalid project audit config ${configPath}: fileNames.enabled must be true or false.`,
        );
      }
      config.FileNames = data.fileNames.enabled;
    }
  }

  if (Object.hasOwn(data, "archiveLinks")) {
    for (const key of Object.keys(data.archiveLinks)) {
      if (!["enabled", "directoryNames"].includes(key)) {
        throw new Error(`Invalid project audit config ${configPath}: unsupported key 'archiveLinks.${key}'.`);
      }
    }
    if (Object.hasOwn(data.archiveLinks, "enabled")) {
      if (typeof data.archiveLinks.enabled !== "boolean") {
        throw new Error(
          `Invalid project audit config ${configPath}: archiveLinks.enabled must be true or false.`,
        );
      }
      config.ArchiveLinks.Enabled = data.archiveLinks.enabled;
    }
    if (Object.hasOwn(data.archiveLinks, "directoryNames")) {
      const names = data.archiveLinks.directoryNames;
      if (!Array.isArray(names) || !names.length) {
        throw new Error(
          `Invalid project audit config ${configPath}: 'archiveLinks.directoryNames' must be a non-empty array.`,
        );
      }
      for (const name of names) {
        if (typeof name !== "string" || !name.trim() || /[\\/]/.test(name) || [".", ".."].includes(name.trim())) {
          throw new Error(
            `Invalid project audit config ${configPath}: archiveLinks.directoryNames entry '${name}' must be a single directory name.`,
          );
        }
      }
      config.ArchiveLinks.DirectoryNames = [...new Set(names.map((name) => name.trim()))];
    }
  }
  return config;
}

export function getAuditFileNameProblems(fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  const allowed = "A-Za-z0-9\\u3400-\\u4DBF\\u4E00-\\u9FFF";
  if (new RegExp(`^[${allowed}]+(?:-[${allowed}]+)*$`, "u").test(stem) && /^\.(?:md|markdown)$/.test(extension)) {
    return [];
  }
  const problems = [];
  if (/\s/.test(fileName)) problems.push("含有空格，请改用连词线（-）");
  if (stem.includes("_")) problems.push("含有下划线，请改用连词线（-）");
  if (stem.includes(".")) problems.push("文件名主体含有点（.），请改用连词线（-）");
  if (/[^\x00-\x7F\u3400-\u4DBF\u4E00-\u9FFF]/u.test(stem)) {
    problems.push("含有中文以外的非 ASCII 字符，如全角标点");
  }
  if (/[^A-Za-z0-9.\-_\s\u3400-\u4DBF\u4E00-\u9FFF]/u.test(stem)) {
    problems.push("含有字母、数字、中文和连词线以外的符号");
  }
  if (!/^\.(?:md|markdown)$/.test(extension)) {
    problems.push("扩展名应为小写的 .md 或 .markdown");
  }
  if (!problems.length) problems.push("连词线不能出现在开头、结尾或连续出现");
  return problems;
}

export function getLinkFindings(report) {
  if (!report || typeof report !== "object" || !Object.hasOwn(report, "error_map")) {
    throw new Error("Unsupported lychee JSON: missing error_map.");
  }
  const findings = [];
  for (const mapName of ["error_map", "timeout_map"]) {
    for (const [source, links] of Object.entries(report[mapName] ?? {})) {
      for (const link of links ?? []) {
        if (!Object.hasOwn(link, "url") || !Object.hasOwn(link, "status")) {
          throw new Error("Unsupported lychee link entry.");
        }
        const code = link.status?.code ?? null;
        const external = /^https?:\/\//.test(link.url);
        const category =
          !external || (mapName !== "timeout_map" && (code === 404 || code === 410)) ? "FAIL" : "REVIEW";
        findings.push({ Source: source, Url: link.url, Status: link.status, Category: category, Map: mapName });
      }
    }
  }
  return findings;
}

function getValeErrorText(stderr) {
  let text = String(stderr ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && Object.hasOwn(parsed, "Text")) {
      return `${parsed.Code} 第 ${parsed.Line} 行：${parsed.Text}`;
    }
  } catch {
    // Fall back to the raw message.
  }
  if (text.length > 500) text = `${text.slice(0, 500)}…`;
  return text;
}

export function getAuditFileBatches(files, root, { baseCharacters = 1024, maxFiles = 128, maxCharacters = 24000 } = {}) {
  const batches = [];
  let batch = [];
  let characters = baseCharacters;
  for (const file of files) {
    const cost = 2 * path.join(root, file).length + 3;
    if (cost + baseCharacters > maxCharacters) {
      throw new Error(`Input path exceeds command-line budget: ${file}`);
    }
    if (batch.length && (batch.length >= maxFiles || characters + cost > maxCharacters)) {
      batches.push({ Files: batch });
      batch = [];
      characters = baseCharacters;
    }
    batch.push(file);
    characters += cost;
  }
  if (batch.length) batches.push({ Files: batch });
  return batches;
}

async function runValeAudit({ runtime, command, prefix, args, files, docRoot, timeoutSeconds, log }) {
  const collected = { ExitCodes: [], Batches: [], Findings: [], FileErrors: [] };
  for (const file of files) {
    let exitCode = null;
    try {
      const output = await runtime.runProfiled({
        command,
        args: [...prefix, ...args, "--", path.join(docRoot, file)],
        timeoutSeconds,
        cwd: docRoot,
        tool: "vale",
        phase: "check",
        file,
        files: [file],
      });
      exitCode = output.exitCode;
      collected.ExitCodes.push(output.exitCode);
      collected.Batches.push({
        Files: [file],
        ExitCode: output.exitCode,
        TimedOut: output.timedOut,
        TimeoutSeconds: timeoutSeconds,
      });
      await appendLog(
        log,
        `FILE: ${file}\nEXIT: ${output.exitCode}\n${output.stdout}\n${output.stderr}`,
      );
      if (output.timedOut) throw new Error(`检查超过 ${timeoutSeconds} 秒仍未完成。`);
      if (![0, 1].includes(output.exitCode)) {
        throw new Error(`退出码 ${output.exitCode}：${getValeErrorText(output.stderr)}`);
      }
      let report;
      try {
        report = JSON.parse(stripAnsi(output.stdout).replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("Vale 输出不是可解析的 JSON。");
      }
      const alerts = Object.values(report ?? {}).flat();
      if (output.exitCode === 1 && !alerts.length) throw new Error("退出码 1 但没有返回告警。");
      if (output.exitCode === 0 && alerts.length) throw new Error("退出码 0 却返回了告警。");
      for (const alert of alerts) {
        collected.Findings.push({
          file,
          line: alert.Line,
          column: alert.Span?.[0],
          rule: alert.Check,
          severity: alert.Severity,
          message: alert.Message,
          match: alert.Match,
        });
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      collected.FileErrors.push({ File: file, ExitCode: exitCode, Message: message });
      await appendLog(log, `ERROR: ${file}\n${message}`);
    }
  }
  return collected;
}

async function discoverGitRoot(runtime, scopeDirectory) {
  const git = await runtime.resolveExecutable("git");
  const result = await runtime.runProfiled({
    command: git,
    args: ["-C", scopeDirectory, "rev-parse", "--show-toplevel"],
    timeoutSeconds: 30,
    cwd: runtime.root,
    tool: "orchestrator",
    phase: "git-root",
  });
  const inGit = result.exitCode === 0 && !result.timedOut && Boolean(result.stdout.trim());
  return {
    git,
    inGit,
    docRoot: inGit ? path.resolve(result.stdout.trim().split(/\r?\n/)[0]) : path.resolve(scopeDirectory),
  };
}

function shouldSkipReport(file, reportRoot) {
  return isPathInside(reportRoot, file);
}

async function collectRecursiveFiles(scope, docRoot, reportRoot, excludes) {
  if (await pathExists(scope, "file")) {
    if (!markdownExtensions.has(path.extname(scope).toLowerCase())) return [];
    return [toPosixRelative(path.relative(docRoot, scope))];
  }
  const files = [];
  const pending = [scope];
  while (pending.length) {
    const directory = pending.pop();
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (skippedDirectoryNames.has(child.name.toLowerCase()) || child.isSymbolicLink()) continue;
        if (shouldSkipReport(full, reportRoot)) continue;
        const relative = toPosixRelative(path.relative(docRoot, full));
        if (matchesExclude(relative, excludes, { isDirectory: true })) continue;
        pending.push(full);
      } else if (child.isFile() || child.isSymbolicLink()) {
        if (!markdownExtensions.has(path.extname(child.name).toLowerCase())) continue;
        if (shouldSkipReport(full, reportRoot)) continue;
        const relative = toPosixRelative(path.relative(docRoot, full));
        if (matchesExclude(relative, excludes)) continue;
        files.push(relative);
      }
    }
  }
  return files;
}

async function collectGitFiles(runtime, git, docRoot, reportRoot, excludes) {
  const result = await runtime.runProfiled({
    command: git,
    args: ["-C", docRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    timeoutSeconds: 30,
    cwd: runtime.root,
    tool: "orchestrator",
    phase: "git-scan",
  });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Git scan failed: ${result.stderr}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => markdownExtensions.has(path.extname(file).toLowerCase()))
    .filter((file) => !shouldSkipReport(path.join(docRoot, file), reportRoot))
    .filter((file) => !matchesExclude(file, excludes));
}

export async function discoverAuditScope({
  scopePath,
  reportRoot,
  runtime,
  onRoot,
  beforeScan,
}) {
  const scope = path.isAbsolute(scopePath) ? path.resolve(scopePath) : path.resolve(runtime.root, scopePath);
  if (!(await pathExists(scope))) throw new Error(`Path not found: ${scope}`);
  const scopeIsDirectory = await pathExists(scope, "directory");
  const scopeDirectory = scopeIsDirectory ? scope : path.dirname(scope);
  const gitInfo = await discoverGitRoot(runtime, scopeDirectory);
  const docRoot = gitInfo.docRoot;
  const relativeScope = path.relative(docRoot, scope);
  if (
    relativeScope === ".." ||
    relativeScope.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeScope)
  ) {
    throw new Error(`Path is outside its Git work tree: ${scope}`);
  }
  const scanMode =
    gitInfo.inGit &&
    scopeIsDirectory &&
    path.resolve(scope).replace(/[\\/]+$/, "").toLowerCase() ===
      path.resolve(docRoot).replace(/[\\/]+$/, "").toLowerCase()
      ? "git"
      : "recursive";
  if (onRoot) {
    await onRoot({ scope, scopeIsDirectory, docRoot, inGit: gitInfo.inGit, scanMode });
  }
  const settingsDirectory = path.join(docRoot, ".wenlab");
  const projectConfig = await readProjectAuditConfig(
    path.join(settingsDirectory, "docs-audit.json"),
    runtime.configRoot,
  );
  const effectiveExcludes = getEffectiveExcludes(projectConfig);
  const excludes = applyScopeExcludeOverride(scope, docRoot, effectiveExcludes, scopeIsDirectory);
  if (beforeScan) {
    await beforeScan({
      scope,
      scopeIsDirectory,
      docRoot,
      scanMode,
      projectConfig,
      effectiveExcludes,
      excludes,
    });
  }
  const started = performance.now();
  let files;
  if (scanMode === "git") {
    files = await collectGitFiles(runtime, gitInfo.git, docRoot, reportRoot, excludes);
  } else {
    files = await collectRecursiveFiles(scope, docRoot, reportRoot, excludes);
    runtime.recordProfile({
      Tool: "orchestrator",
      Phase: "file-scan",
      File: "",
      Files: [],
      Executable: "filesystem",
      DurationMs: performance.now() - started,
      ExitCode: 0,
      TimedOut: false,
      Error: "",
    });
  }
  files = [...new Set(files)].sort();
  return {
    scope,
    scopeDirectory,
    scopeIsDirectory,
    docRoot,
    inGit: gitInfo.inGit,
    scanMode,
    projectConfig,
    effectiveExcludes,
    excludes,
    files,
  };
}

export async function getAuditArchiveLinks(files, docRoot, directoryNames) {
  const pattern = /(?:!?\[[^\]]*\]\(\s*|^\s{0,3}\[[^\]]+\]:\s*)(?<target><[^>]*>|[^\s)]+)/g;
  const archiveNames = new Set(directoryNames.map((name) => name.toLowerCase()));
  const isArchive = (segment) => archiveNames.has(segment.toLowerCase());
  const found = [];
  for (const file of files) {
    const sourceParts = file.split("/");
    sourceParts.pop();
    if (sourceParts.some(isArchive)) continue;
    const full = path.join(docRoot, file);
    const lines = (await fs.readFile(full, "utf8")).split(/\r?\n/);
    let fence = null;
    for (let index = 0; index < lines.length; index += 1) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index]);
      if (marker) {
        const character = marker[1][0];
        if (!fence) fence = character;
        else if (character === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const masked = lines[index].replace(/(`+).*?\1/g, (match) => " ".repeat(match.length));
      for (const match of masked.matchAll(pattern)) {
        const target = match.groups.target.replace(/^<|>$/g, "");
        let targetPath = target.split("#")[0].split("?")[0];
        if (
          !targetPath ||
          targetPath.startsWith("//") ||
          /^[A-Za-z][A-Za-z0-9+.-]*:/.test(targetPath)
        ) {
          continue;
        }
        try {
          targetPath = decodeURIComponent(targetPath);
        } catch {
          continue;
        }
        const base = targetPath.startsWith("/") ? docRoot : path.dirname(full);
        let resolved;
        try {
          resolved = path.resolve(base, targetPath.replace(/^\/+/, ""));
        } catch {
          continue;
        }
        const segments = path.relative(docRoot, resolved).split(/[\\/]/);
        if (segments.some(isArchive)) {
          found.push({
            File: file,
            Line: index + 1,
            Column: match.index + 1,
            Target: target,
          });
        }
      }
    }
  }
  return found;
}

function outputTiming(result) {
  return typeof result.DurationMs === "number" ? ` (${(result.DurationMs / 1000).toFixed(3)} s)` : "";
}

async function profileStatistics(runtime) {
  const groups = new Map();
  for (const call of runtime.profileCalls) {
    const key = `${call.Tool}\0${call.Phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  return [...groups.values()].map((group) => {
    const durations = group.map((call) => call.DurationMs);
    const total = durations.reduce((sum, value) => sum + value, 0);
    return {
      Tool: group[0].Tool,
      Phase: group[0].Phase,
      Count: group.length,
      TotalMs: total,
      MinMs: Math.min(...durations),
      MaxMs: Math.max(...durations),
      AverageMs: total / durations.length,
    };
  });
}

function newRunDirectory(reportRoot, gate) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const id = crypto.randomBytes(4).toString("hex");
  return path.join(reportRoot, gate, `${stamp}-${id}`);
}

export async function invokeDocsAudit(options = {}, overrides = {}) {
  const runtime = overrides.runtime ?? createRuntime(overrides.runtimeOptions ?? {});
  const reviewFactory = overrides.reviewFactory ?? createReviewArtifacts;
  const gate = options.gate ?? "LocalGate";
  if (!["LocalGate", "RemoteGate"].includes(gate)) throw new Error(`Unsupported gate: ${gate}`);
  const timeoutSeconds = Number(options.timeoutSeconds ?? 180);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error("TimeoutSeconds must be an integer between 1 and 3600.");
  }
  runtime.setProfiler(Boolean(options.profiler));
  const auditStarted = performance.now();
  const results = [];
  let files = [];
  let archiveLinks = [];
  let archiveLinksScanned = false;
  let exitCode = 0;
  let scope = null;
  const reportRoot = path.isAbsolute(options.reportDirectory ?? ".tmp/docs-audit")
    ? path.resolve(options.reportDirectory ?? ".tmp/docs-audit")
    : path.resolve(runtime.root, options.reportDirectory ?? ".tmp/docs-audit");
  const run = newRunDirectory(reportRoot, gate);
  await fs.mkdir(run, { recursive: true });

  let docRoot = null;
  let scanMode = null;
  let projectConfig = null;
  let effectiveExcludes = [];
  let excludes = [];
  const warnings = [];
  const dictionaryInfo = {
    Base: path.join(runtime.configRoot, "dictionary.txt"),
    Project: null,
    ProjectFound: false,
    ProjectIsBase: false,
    Extra: null,
  };

  try {
    const discovered = await discoverAuditScope({
      scopePath: options.path ?? "docs",
      reportRoot,
      runtime,
      onRoot: ({ scope: discoveredScope, docRoot: discoveredRoot, scanMode: discoveredMode }) => {
        scope = discoveredScope;
        docRoot = discoveredRoot;
        scanMode = discoveredMode;
      },
      beforeScan: async ({ docRoot: discoveredRoot, projectConfig: discoveredConfig }) => {
        docRoot = discoveredRoot;
        projectConfig = discoveredConfig;
        dictionaryInfo.Project = path.join(docRoot, ".wenlab", "dictionary.txt");
        dictionaryInfo.ProjectFound = await pathExists(dictionaryInfo.Project, "file");
        dictionaryInfo.ProjectIsBase =
          path.resolve(dictionaryInfo.Project).toLowerCase() ===
          path.resolve(dictionaryInfo.Base).toLowerCase();
        if (!dictionaryInfo.ProjectFound) {
          warnings.push(
            `项目词典不存在：${dictionaryInfo.Project}；本次 CSpell 只使用 wenlab 词典${options.dictionary ? "和 -Dictionary 附加的词典" : ""}。`,
          );
        }
        if (options.dictionary) {
          const candidate = path.isAbsolute(options.dictionary)
            ? path.resolve(options.dictionary)
            : path.resolve(docRoot, options.dictionary);
          if (!(await pathExists(candidate, "file"))) throw new Error(`Dictionary not found: ${candidate}`);
          dictionaryInfo.Extra = candidate;
        }
      },
    });
    ({ scope, docRoot, scanMode, projectConfig, effectiveExcludes, excludes, files } = discovered);
    if (!files.length) throw new Error(`No Markdown files under ${options.path ?? "docs"}.`);
    for (const file of files) {
      if (!(await pathExists(path.join(docRoot, file), "file"))) {
        throw new Error(`Missing input file: ${file}`);
      }
    }
    const before = new Map();
    for (const file of files) before.set(file, await sha256File(path.join(docRoot, file)));
    if (projectConfig.ArchiveLinks.Enabled && projectConfig.ArchiveLinks.DirectoryNames.length) {
      archiveLinks = await getAuditArchiveLinks(files, docRoot, projectConfig.ArchiveLinks.DirectoryNames);
      archiveLinksScanned = true;
    }
    const inputList = path.join(run, "input-files.txt");
    await fs.writeFile(
      inputList,
      `${files.map((file) => path.join(docRoot, file)).join("\n")}\n`,
      "utf8",
    );

    if (projectConfig.FileNames) {
      const started = performance.now();
      const nameResult = {
        Tool: "filenames",
        Status: "PASS",
        Version: "内置",
        ExitCodes: [],
        Batches: [],
        Message: "",
        Findings: [],
      };
      for (const file of files) {
        const problems = getAuditFileNameProblems(path.basename(file));
        if (problems.length) nameResult.Findings.push({ File: file, Problems: problems });
      }
      if (nameResult.Findings.length) nameResult.Status = "FAIL";
      if (options.profiler) nameResult.DurationMs = performance.now() - started;
      results.push(nameResult);
      console.log(`[${nameResult.Status}] filenames`);
    }

    const checks = ["autocorrect", "rumdl", "cspell", "prettier", "vale", "lychee-local"];
    if (gate === "RemoteGate") checks.push("lychee-online");

    for (const check of checks) {
      const started = performance.now();
      const result = {
        Tool: check,
        Status: "ERROR",
        Version: null,
        ExitCodes: [],
        Batches: [],
        Message: "",
        Findings: [],
        Log: `${check}.log`,
      };
      const log = path.join(run, result.Log);
      try {
        let tool;
        let args;
        let qualityExit = 1;
        let config;
        let prefix = [];
        if (check === "autocorrect") {
          tool = { command: await runtime.resolveExecutable("autocorrect"), prefix: [] };
          config = path.join(runtime.configRoot, ".autocorrectrc");
          args = ["--lint", "--strict", "--format", "json", "--config", config];
        } else if (check === "rumdl") {
          tool = { command: await runtime.resolveExecutable("rumdl"), prefix: [] };
          config = path.join(runtime.configRoot, "rumdl.toml");
          args = [
            "check",
            "--config",
            config,
            "--no-code-block-tools",
            "--no-cache",
            "--deny-config-warnings",
            "--fail-on",
            "any",
            "--output-format",
            "json",
            "--color",
            "never",
          ];
          if (projectConfig.RumdlDisable.length) {
            args.push("--extend-disable", projectConfig.RumdlDisable.join(","));
          }
        } else if (check === "cspell") {
          tool = await runtime.getNpmTool(check, "10.3.6");
          prefix = tool.prefix;
          config = path.join(runtime.configRoot, "cspell.json");
          const definitions = [];
          if (dictionaryInfo.ProjectFound && !dictionaryInfo.ProjectIsBase) {
            definitions.push({ name: "project", path: dictionaryInfo.Project, addWords: true });
          }
          if (dictionaryInfo.Extra) {
            definitions.push({ name: "extra", path: dictionaryInfo.Extra });
          }
          if (definitions.length) {
            config = path.join(run, "cspell-config.json");
            await writeJson(config, {
              version: "0.2",
              import: [path.join(runtime.configRoot, "cspell.json")],
              dictionaryDefinitions: definitions,
              dictionaries: definitions.map((definition) => definition.name),
            });
          }
          args = ["lint", "--config", config, "--no-progress", "--no-summary"];
        } else if (check === "prettier") {
          tool = await runtime.getNpmTool(check, "3.9.9");
          prefix = tool.prefix;
          config = path.join(runtime.configRoot, ".prettierrc.json");
          args = [
            "--check",
            "--config",
            config,
            "--ignore-path",
            path.join(runtime.configRoot, ".prettierignore"),
          ];
        } else if (check === "vale") {
          tool = { command: await runtime.resolveExecutable("vale"), prefix: [] };
          config = path.join(runtime.configRoot, ".vale.ini");
          if (projectConfig.ValeDisable.length) {
            const baseText = await fs.readFile(config, "utf8");
            let runText = baseText.replace(
              /^(StylesPath\s*=\s*)(.+?)\s*$/m,
              (_, prefixText, stylePath) =>
                `${prefixText}${path.resolve(runtime.configRoot, stylePath).replaceAll("\\", "/")}`,
            );
            runText = `${runText.trimEnd()}\n${projectConfig.ValeDisable.map((rule) => `${rule} = NO`).join("\n")}\n`;
            config = path.join(run, "vale.ini");
            await fs.writeFile(config, runText, "utf8");
          }
          args = ["--config", config, "--output=JSON"];
        } else {
          tool = { command: await runtime.resolveExecutable("lychee"), prefix: [] };
          config = path.join(runtime.configRoot, "lychee.toml");
          args = [
            "--config",
            config,
            "--no-progress",
            "--format",
            "json",
            "--include-fragments",
            "--root-dir",
            docRoot,
          ];
          if (check === "lychee-local") args.push("--offline");
          for (const pattern of projectConfig.LycheeExclude) args.push("--exclude", pattern);
          qualityExit = 2;
        }
        if (!(await pathExists(config, "file"))) throw new Error(`Missing config: ${config}`);
        const version = await runtime.runProfiled({
          command: tool.command,
          args: [...tool.prefix, "--version"],
          timeoutSeconds: 15,
          cwd: runtime.root,
          tool: check,
          phase: "version",
        });
        if (version.exitCode !== 0 || version.timedOut) {
          throw new Error(`Version probe failed: ${version.stderr}`);
        }
        result.Version = version.stdout.trim();
        if (check === "autocorrect" && result.Version !== "AutoCorrect 2.16.3") {
          throw new Error("AutoCorrect 2.16.3 is required.");
        }
        if (check === "rumdl" && result.Version !== "rumdl 0.3.0") {
          throw new Error("rumdl 0.3.0 is required.");
        }
        if (check === "vale" && result.Version !== "vale version v3.24.0") {
          throw new Error("Vale 3.24.0 is required.");
        }
        if (check.startsWith("lychee-") && result.Version !== "lychee 0.24.2") {
          throw new Error("lychee 0.24.2 is required.");
        }
        if (check === "prettier") {
          const requestPath = path.join(run, "prettier-check-request.json");
          await writeJson(requestPath, {
            Config: config,
            IgnorePath: path.join(runtime.configRoot, ".prettierignore"),
            Files: files.map((file) => ({ File: file, Source: path.join(docRoot, file) })),
          });
          prefix = [path.join(packageRoot, "Check-Markdown.mjs")];
          args = [requestPath];
        }
        result.Status = "PASS";

        if (check === "vale") {
          const vale = await runValeAudit({
            runtime,
            command: tool.command,
            prefix,
            args,
            files,
            docRoot,
            timeoutSeconds,
            log,
          });
          result.ExitCodes = vale.ExitCodes;
          result.Batches = vale.Batches;
          result.Findings = vale.Findings;
          result.FileErrors = vale.FileErrors;
          if (vale.FileErrors.length) {
            result.Status = "ERROR";
            result.Message = `Vale 未能完成 ${vale.FileErrors.length}/${files.length} 篇文档的检查，其余文档已检查完毕；详见 diagnosis.md。`;
          } else if (vale.Findings.length) {
            result.Status = "FAIL";
          }
        }

        const batches =
          check === "vale"
            ? []
            : ["cspell", "prettier", "lychee-local", "lychee-online"].includes(check)
              ? [{ Files: files }]
              : files.map((file) => ({ Files: [file] }));
        let batchIndex = 0;
        for (const batch of batches) {
          batchIndex += 1;
          const batchFiles = batch.Files;
          const fileLabel =
            batchFiles.length === 1 ? batchFiles[0] : `batch ${batchIndex} (${batchFiles.length} files)`;
          const fileArgs = [...args];
          const jsonFile = path.join(run, `${check}-${batchIndex}.json`);
          if (check.startsWith("lychee-")) fileArgs.push("--output", jsonFile);
          if (check === "cspell") fileArgs.push("--file-list", inputList);
          else if (check.startsWith("lychee-")) fileArgs.push("--files-from", inputList);
          else if (check !== "prettier") {
            fileArgs.push("--", ...batchFiles.map((file) => path.join(docRoot, file)));
          }
          const batchTimeout = Math.min(timeoutSeconds * batchFiles.length, 3_600 * 128);
          const output = await runtime.runProfiled({
            command: tool.command,
            args: [...prefix, ...fileArgs],
            timeoutSeconds: batchTimeout,
            cwd: docRoot,
            tool: check,
            phase: "check",
            file: fileLabel,
            files: batchFiles,
          });
          result.ExitCodes.push(output.exitCode);
          result.Batches.push({
            Files: batchFiles,
            ExitCode: output.exitCode,
            TimedOut: output.timedOut,
            TimeoutSeconds: batchTimeout,
          });
          await appendLog(
            log,
            `FILE: ${fileLabel}\nFILES: ${JSON.stringify(batchFiles)}\nEXIT: ${output.exitCode}\n${output.stdout}\n${output.stderr}`,
          );
          if (output.timedOut) throw new Error(`Tool exceeded ${batchTimeout} seconds for ${fileLabel}.`);

          if (check === "prettier") {
            const records = JSON.parse(stripAnsi(output.stdout));
            result.ConfigurationRecords = [];
            if (!Array.isArray(records) || records.length !== batchFiles.length) {
              throw new Error("Prettier API returned an incomplete inventory.");
            }
            records.forEach((record, recordIndex) => {
              if (record.Configuration) {
                result.ConfigurationRecords.push({
                  File: record.File,
                  Configuration: record.Configuration,
                });
              }
              if (
                record.File !== batchFiles[recordIndex] ||
                !["PASS", "FAIL", "ERROR"].includes(record.Status)
              ) {
                throw new Error("Invalid Prettier API result.");
              }
              if (record.Status !== "PASS") {
                result.Findings.push({ File: record.File, Status: record.Status, Message: record.Error });
              }
              if (options.profiler) {
                runtime.profileCalls.push({
                  Tool: "prettier",
                  Phase: "check-api",
                  File: record.File,
                  Files: [record.File],
                  Executable: "Prettier API",
                  DurationMs: record.DurationMs,
                  ExitCode: record.Status === "ERROR" ? 2 : record.Status === "FAIL" ? 1 : 0,
                  TimedOut: false,
                  Error: record.Error,
                });
              }
            });
            const expectedExit = records.some((record) => record.Status === "ERROR")
              ? 2
              : records.some((record) => record.Status === "FAIL")
                ? 1
                : 0;
            if (output.exitCode !== expectedExit) {
              throw new Error("Inconsistent Prettier API exit code and results.");
            }
            await fs.writeFile(path.join(run, "prettier-check.json"), output.stdout, "utf8");
          }
          if (![0, qualityExit].includes(output.exitCode)) {
            throw new Error(`Unexpected tool exit ${output.exitCode} for ${fileLabel}; see log.`);
          }
          if (check === "autocorrect") {
            const diagnostics = getAutoCorrectFindings(output.stdout);
            if (output.exitCode === 1 && !diagnostics.length) {
              throw new Error("AutoCorrect failed without supported diagnostic entries; see log.");
            }
            result.Findings.push(...diagnostics);
            if (diagnostics.length) result.Status = "FAIL";
          }
          if (check === "cspell") {
            result.Findings.push(...getCSpellFindings(`${output.stdout}\n${output.stderr}`));
          }
          if (check === "rumdl") {
            const text = stripAnsi(output.stdout).trim();
            if (text) result.Findings.push(...JSON.parse(text));
          }
          if (check.startsWith("lychee-")) {
            let report;
            try {
              report = await readJson(jsonFile);
            } catch {
              throw new Error("无法读取 lychee JSON 报告。");
            }
            const findings = getLinkFindings(report);
            if (output.exitCode === qualityExit && !findings.length) {
              throw new Error("lychee failed but returned no supported error entries.");
            }
            if (output.exitCode === 0 && findings.length) {
              throw new Error("Inconsistent lychee report: exit 0 with error entries.");
            }
            result.Findings.push(...findings);
            if (findings.some((finding) => finding.Category === "FAIL")) result.Status = "FAIL";
            else if (findings.length && result.Status === "PASS") result.Status = "REVIEW";
          } else if (output.exitCode === qualityExit) {
            result.Status = "FAIL";
          }
        }
      } catch (failure) {
        result.Status = "ERROR";
        result.Message = failure instanceof Error ? failure.message : String(failure);
        await appendLog(log, `${result.Message}\n`);
      }
      if (options.profiler) result.DurationMs = performance.now() - started;
      results.push(result);
      console.log(`[${result.Status}] ${check}${outputTiming(result)} ${result.Message}`);
    }

    for (const file of files) {
      if ((await sha256File(path.join(docRoot, file))) !== before.get(file)) {
        throw new Error(`Read-only invariant violated: ${file}`);
      }
    }
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    results.push({ Tool: "orchestrator", Status: "ERROR", Message: message });
    console.log(`[ERROR] ${message}`);
  }

  const statuses = results.map((result) => result.Status);
  exitCode = statuses.includes("ERROR")
    ? 2
    : statuses.includes("FAIL")
      ? 1
      : statuses.includes("REVIEW")
        ? 3
        : 0;
  const summaryStatus = statuses.includes("ERROR")
    ? "ERROR"
    : statuses.includes("FAIL")
      ? "FAIL"
      : statuses.includes("REVIEW")
        ? "REVIEW"
        : "PASS";
  const summary = {
    Gate: gate,
    GateName: gate === "RemoteGate" ? "远程格式质量阀门" : "本地格式质量阀门",
    Status: summaryStatus,
    ExitCode: exitCode,
    TimestampUtc: new Date().toISOString(),
    Root: docRoot,
    Scope: scope ?? options.path ?? "docs",
    ScanMode: scanMode,
    Files: files,
    Results: results,
    Dictionary: dictionaryInfo,
    ProjectConfig: projectConfig,
    Exclusions: {
      Project: projectConfig?.Exclude ?? [],
      Effective: effectiveExcludes,
      Applied: excludes,
    },
    Warnings: warnings,
    ArchiveLinks: archiveLinks,
    ArchiveLinksScanned: archiveLinksScanned,
    Invocation: {
      TimeoutSeconds: timeoutSeconds,
      Profiler: Boolean(options.profiler),
      Dictionary: options.dictionary ?? null,
    },
    NotVerified: [
      "中文错别字与语病",
      "跨文档语义一致性与重复",
      "Obsidian/MDX 等扩展语法",
      ...(gate === "RemoteGate" ? [] : ["外部 URL 可达性"]),
    ],
  };
  let reviewTimer = 0;
  try {
    const reviewStarted = performance.now();
    if (files.length) {
      try {
        summary.Review = await reviewFactory(
          summary,
          run,
          scope ?? path.resolve(runtime.root, options.path ?? "docs"),
          timeoutSeconds,
          runtime,
        );
        if (summary.Review.RejectedFiles?.length) {
          summary.Status = "ERROR";
          summary.ExitCode = 2;
          exitCode = 2;
          const formatResult = summary.Results.find((result) => result.Tool === "prettier");
          if (formatResult) {
            formatResult.Status = "ERROR";
            formatResult.Message = `${summary.Review.RejectedFiles.length} 篇预览被隔离（格式不稳定、配置不一致或格式化错误）；原文副本已保留，详见报告独立清单。`;
          }
          console.log(`[ERROR] ${formatResult?.Message ?? "预览被隔离。"}`);
        }
      } catch (failure) {
        summary.Review = {
          Status: "ERROR",
          Message: failure instanceof Error ? failure.message : String(failure),
        };
        summary.Status = "ERROR";
        summary.ExitCode = 2;
        exitCode = 2;
        console.log(`[ERROR] Review artifacts: ${summary.Review.Message}`);
      }
    }
    reviewTimer = performance.now() - reviewStarted;
    if (options.profiler) {
      const duration = performance.now() - auditStarted;
      const statistics = await profileStatistics(runtime);
      summary.Profile = {
        Enabled: true,
        DurationMs: duration,
        ReviewArtifactsMs: reviewTimer,
        Statistics: statistics,
        Calls: runtime.profileCalls,
        Note:
          "Wall-clock milliseconds; tool totals include subprocess time and orchestration. Review overlaps preview calls. Final report serialization and disk writes are excluded.",
      };
      await writeJson(path.join(run, "profile.json"), summary.Profile);
      console.log(`[PROFILE] total ${(duration / 1000).toFixed(3)} s; review artifacts ${(reviewTimer / 1000).toFixed(3)} s`);
      for (const statistic of statistics) {
        console.log(
          `[PROFILE] ${statistic.Tool}/${statistic.Phase}: ${statistic.Count} calls, total ${(statistic.TotalMs / 1000).toFixed(3)} s, avg ${statistic.AverageMs.toFixed(3)} ms, max ${statistic.MaxMs.toFixed(3)} ms`,
        );
      }
    }
    await writeJson(path.join(run, "summary.json"), summary);
    await writeAuditDiagnosis(summary, run, runtime);
    console.log(`${gate} ${summary.Status}: ${files.length} files`);
    for (const warning of summary.Warnings) console.log(`[WARN] ${warning}`);
    if (archiveLinks.length) {
      console.log(
        `[INFO] ${archiveLinks.length} 处链接指向归档目录（${projectConfig.ArchiveLinks.DirectoryNames.join("、")}）下的归档文档（不影响结果），清单见 diagnosis.md 的「对归档文档的链接引用」一节。`,
      );
      if (exitCode === 0) console.log(path.join(run, "diagnosis.md"));
    }
    if (exitCode !== 0) {
      console.log("诊断与修复建议：");
      console.log(path.join(run, "diagnosis.md"));
    }
    if (exitCode !== 0 && summary.Review?.Status === "READY") {
      console.log("打开 GUI 全量规则比对：");
      console.log(`node '${path.join(run, summary.Review.Launcher)}'`);
    }
  } catch (failure) {
    console.log(
      `[ERROR] Cannot write report: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return 2;
  }
  return exitCode;
}
