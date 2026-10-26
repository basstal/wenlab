import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const packageRoot = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const configRoot = path.join(repoRoot, ".wenlab");
export const minimumNodeVersion = "22.18.0";

export const stripAnsi = (text) => String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export async function pathExists(target, type = "any") {
  try {
    const stat = await fs.stat(target);
    if (type === "file") return stat.isFile();
    if (type === "directory") return stat.isDirectory();
    return true;
  } catch {
    return false;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(target) {
  return sha256(await fs.readFile(target));
}

export async function readJson(target) {
  return JSON.parse((await fs.readFile(target, "utf8")).replace(/^\uFEFF/, ""));
}

export async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendLog(target, text) {
  await fs.appendFile(target, text, "utf8");
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative) return true;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return true;
}

export function toPosixRelative(value) {
  return value.split(path.sep).join("/");
}

export function findExecutable(name, env = process.env) {
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const hasExtension = Boolean(path.extname(name));
  const candidates = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      candidates.push(path.join(directory, hasExtension ? name : `${name}${extension.toLowerCase()}`));
      if (process.platform === "win32" && extension !== extension.toLowerCase()) {
        candidates.push(path.join(directory, `${name}${extension}`));
      }
    }
  }
  return candidates;
}

export async function resolvePathExecutable(name) {
  if (path.isAbsolute(name) || name.includes(path.sep)) {
    return (await pathExists(name, "file")) ? path.resolve(name) : null;
  }
  for (const candidate of findExecutable(name)) {
    if (await pathExists(candidate, "file")) return candidate;
  }
  return null;
}

export async function defaultResolveExecutable(name) {
  const localNames = process.platform === "win32" ? [`${name}.exe`, name] : [name, `${name}.exe`];
  for (const localName of localNames) {
    const local = path.join(repoRoot, "tools", "docs-audit", "bin", localName);
    if (await pathExists(local, "file")) return local;
  }
  const resolved = await resolvePathExecutable(name);
  if (!resolved) {
    throw new Error(`Missing executable: ${name}. See docs/依赖安装说明.md; automatic installation is disabled.`);
  }
  return resolved;
}

function terminateProcess(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already have exited.
  }
}

export async function runProcessReal({
  command,
  args = [],
  timeoutSeconds = 180,
  cwd = repoRoot,
  env = process.env,
}) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: { ...env, NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeoutMs = Math.min(
      Math.max(1, Math.trunc(timeoutSeconds * 1000)),
      Math.trunc(2_147_483_647 / 1000) * 1000,
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (timedOut ? 1 : 0),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function readNpmBin(packageName, version, root = packageRoot) {
  if (compareVersions(process.versions.node, minimumNodeVersion) < 0) {
    throw new Error(`Node.js >=${minimumNodeVersion} is required.`);
  }
  const folder = path.join(root, "node_modules", packageName);
  const metadataPath = path.join(folder, "package.json");
  if (!(await pathExists(metadataPath, "file"))) {
    throw new Error(`Missing ${packageName}@${version}. See docs/依赖安装说明.md; automatic installation is disabled.`);
  }
  const metadata = await readJson(metadataPath);
  if (metadata.version !== version) {
    throw new Error(`${packageName} requires ${version}; found ${metadata.version}.`);
  }
  const bin =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin?.[
          Object.keys(metadata.bin ?? {}).find((key) => key.toLowerCase() === packageName) ?? packageName
        ];
  if (!bin) throw new Error(`Missing CLI entry: ${packageName}`);
  const entry = path.resolve(folder, bin);
  if (!isPathInside(folder, entry)) throw new Error(`Invalid bin path: ${packageName}`);
  if (!(await pathExists(entry, "file"))) throw new Error(`Missing CLI: ${entry}`);
  return {
    command: process.execPath,
    prefix: [entry],
    version: metadata.version,
  };
}

export function createRuntime(overrides = {}) {
  const runProcess = overrides.runProcess ?? runProcessReal;
  const resolveExecutable = overrides.resolveExecutable ?? defaultResolveExecutable;
  const getNpmTool = overrides.getNpmTool ?? readNpmBin;
  const profileCalls = [];
  let profilerEnabled = false;

  return {
    root: repoRoot,
    configRoot,
    packageRoot,
    profileCalls,
    get profilerEnabled() {
      return profilerEnabled;
    },
    setProfiler(enabled) {
      profilerEnabled = Boolean(enabled);
    },
    recordProfile(call) {
      if (!profilerEnabled) return;
      profileCalls.push(call);
    },
    async runProfiled(options) {
      if (!profilerEnabled) return await runProcess(options);
      const started = performance.now();
      let output = null;
      let error = "";
      try {
        output = await runProcess(options);
        return output;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        profileCalls.push({
          Tool: options.tool ?? "",
          Phase: options.phase ?? "",
          File: options.file ?? "",
          Files: options.files ?? [],
          Executable: options.command ?? "",
          DurationMs: performance.now() - started,
          ExitCode: output ? output.exitCode : null,
          TimedOut: output ? Boolean(output.timedOut) : false,
          Error: error,
        });
      }
    },
    runProcess,
    resolveExecutable,
    async getNpmTool(packageName, version) {
      return await getNpmTool(packageName, version, packageRoot);
    },
  };
}
