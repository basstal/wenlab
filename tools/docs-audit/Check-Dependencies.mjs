#!/usr/bin/env node
import path from "node:path";
import {
  compareVersions,
  createRuntime,
  minimumNodeVersion,
  repoRoot,
  runProcessReal,
} from "./AuditRuntime.mjs";

const checks = [];
const failures = [];
const runtime = createRuntime();
const localToolRoot = path.join(repoRoot, "tools", "docs-audit", "bin").toLowerCase();

function sourceLabel(command) {
  return path.resolve(command).toLowerCase().startsWith(localToolRoot) ? "本地 bin" : "PATH";
}

function addCheck(name, ok, detail, hint = "") {
  checks.push({ name, ok, detail, hint });
  if (!ok) failures.push({ name, detail, hint });
}

async function versionOf(command, args, timeoutSeconds = 15) {
  const output = await runProcessReal({
    command,
    args,
    timeoutSeconds,
    cwd: repoRoot,
  });
  if (output.timedOut) throw new Error(`版本检查超时：${timeoutSeconds} 秒`);
  if (output.exitCode !== 0) {
    throw new Error(output.stderr.trim() || `退出码 ${output.exitCode}`);
  }
  return output.stdout.trim();
}

async function checkPathTool(name, commandName, expectedVersion) {
  try {
    const command = await runtime.resolveExecutable(commandName);
    const source = sourceLabel(command);
    const version = await versionOf(command, ["--version"]);
    addCheck(
      name,
      version === expectedVersion,
      `${version}（${source}）`,
      version === expectedVersion ? "" : `需要 ${expectedVersion}，收到 ${version}`,
    );
  } catch (failure) {
    addCheck(
      name,
      false,
      failure instanceof Error ? failure.message : String(failure),
      `在 tools/docs-audit/bin/ 或 PATH 中提供 ${commandName}`,
    );
  }
}

async function checkNpmTool(name, packageName, expectedVersion) {
  try {
    const tool = await runtime.getNpmTool(packageName, expectedVersion);
    const version = await versionOf(
      tool.command,
      [...tool.prefix, "--version"],
    );
    addCheck(
      name,
      version === expectedVersion,
      `${version}（npm devDependency）`,
      version === expectedVersion
        ? ""
        : `需要 ${expectedVersion}，收到 ${version}`,
    );
  } catch (failure) {
    addCheck(
      name,
      false,
      failure instanceof Error ? failure.message : String(failure),
      "按 docs/依赖安装说明.md 中的 npm ci 命令安装",
    );
  }
}

const nodeVersion = process.versions.node;
addCheck(
  "Node.js",
  compareVersions(nodeVersion, minimumNodeVersion) >= 0,
  `${nodeVersion}（当前 Node.js 进程）`,
  `需要 ${minimumNodeVersion} 或更新版本`,
);

try {
  const git = await runtime.resolveExecutable("git");
  const version = await versionOf(git, ["--version"]);
  addCheck("Git", true, `${version}（${sourceLabel(git)}）`);
} catch (failure) {
  addCheck(
    "Git",
    false,
    failure instanceof Error ? failure.message : String(failure),
    "在 tools/docs-audit/bin/ 或 PATH 中提供 Git",
  );
}

await checkNpmTool("CSpell", "cspell", "10.3.6");
await checkNpmTool("Prettier", "prettier", "3.9.9");
await checkPathTool("AutoCorrect", "autocorrect", "AutoCorrect 2.16.3");
await checkPathTool("rumdl", "rumdl", "rumdl 0.3.0");
await checkPathTool("Vale", "vale", "vale version v3.24.0");
await checkPathTool("lychee", "lychee", "lychee 0.24.2");

for (const check of checks) {
  console.log(`[${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
  if (!check.ok && check.hint) console.log(`        ${check.hint}`);
}

if (failures.length) {
  console.error(`依赖检测失败：${failures.length} 项不可用。`);
  process.exitCode = 1;
} else {
  console.log("依赖检测通过：Node.js、Git、npm 依赖和本机原生工具均可用。");
}
