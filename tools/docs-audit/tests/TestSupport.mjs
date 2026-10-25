import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const auditRoot = path.join(repoRoot, ".tmp", "docs-audit");

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

export async function run(command, args, { cwd = repoRoot, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export async function createTempProject(prefix) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const project = path.join(os.tmpdir(), `${prefix}-${id}`);
  await fs.mkdir(project, { recursive: true });
  return { project, id };
}

export async function cleanupTempProject(project, prefix, id) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(project);
  const relative = path.relative(tempRoot, resolved);
  assert(
    relative &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      path.basename(resolved) === `${prefix}-${id}`,
    `Unsafe test cleanup path: ${resolved}`,
  );
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function initGit(project) {
  const result = await run("git", ["init", "-q", "--", project]);
  assertEqual(result.code, 0, `git init failed: ${result.stderr}`);
}

export async function writeFile(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

export async function latestRun(reportDirectory) {
  const entries = await fs.readdir(reportDirectory, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  assert(directories.length > 0, `No report runs under ${reportDirectory}`);
  directories.sort((left, right) => left.name.localeCompare(right.name));
  return path.join(reportDirectory, directories.at(-1).name);
}

export async function latestSummary(reportDirectory) {
  const runDirectory = await latestRun(reportDirectory);
  return {
    runDirectory,
    summary: JSON.parse(await fs.readFile(path.join(runDirectory, "summary.json"), "utf8")),
    diagnosis: await fs.readFile(path.join(runDirectory, "diagnosis.md"), "utf8"),
  };
}

export function testReportPath(name) {
  return path.join(auditRoot, "node-tests", `${name}-${crypto.randomUUID().replaceAll("-", "")}`);
}
