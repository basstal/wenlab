#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parse(argv) {
  const options = {
    RunDirectory: path.dirname(fileURLToPath(import.meta.url)),
    BeyondComparePath: "",
    CheckOnly: false,
    Help: false,
  };
  const names = new Map([
    ["rundirectory", "RunDirectory"],
    ["run-directory", "RunDirectory"],
    ["beyondcomparepath", "BeyondComparePath"],
    ["beyond-compare-path", "BeyondComparePath"],
    ["checkonly", "CheckOnly"],
    ["check-only", "CheckOnly"],
    ["help", "Help"],
    ["h", "Help"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equal = token.indexOf("=");
    const raw = equal >= 0 ? token.slice(0, equal) : token;
    const key = names.get(raw.replace(/^--?/, "").toLowerCase());
    if (!key) throw new Error(`Unknown option: ${raw}`);
    if (key === "CheckOnly" || key === "Help") {
      options[key] = true;
      continue;
    }
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (value === undefined) throw new Error(`Option ${raw} requires a value.`);
    options[key] = value;
  }
  return options;
}

async function exists(target, type = "any") {
  try {
    const stat = await fs.stat(target);
    if (type === "file") return stat.isFile();
    if (type === "directory") return stat.isDirectory();
    return true;
  } catch {
    return false;
  }
}

async function hashFile(target) {
  return createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zipSingleFile(fileName, contents) {
  const name = Buffer.from(fileName, "utf8");
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const checksum = crc32(data);
  const timestamp = dosTimestamp();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(timestamp.time, 10);
  local.writeUInt16LE(timestamp.date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const centralOffset = local.length + name.length + data.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(timestamp.time, 12);
  central.writeUInt16LE(timestamp.date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralDirectory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, data, centralDirectory, end]);
}

function waitForExit(child, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore a process that already exited.
      }
      reject(new Error(message));
    }, timeoutMs);
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
      resolve(code);
    });
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.Help) {
    console.log(
      "Usage: node Open-Comparison.mjs [-RunDirectory <directory>] [-BeyondComparePath <file>] [-CheckOnly]",
    );
    return 0;
  }
  const run = path.resolve(options.RunDirectory);
  const manifest = JSON.parse(await fs.readFile(path.join(run, "comparison.json"), "utf8"));
  const beyondCompare =
    options.BeyondComparePath || process.env.BEYOND_COMPARE_EXE || manifest.BeyondCompareExecutable;
  if (!beyondCompare || !(await exists(beyondCompare, "file"))) {
    throw new Error(
      "未找到 Beyond Compare，请通过 -BeyondComparePath 或 BEYOND_COMPARE_EXE 指定已有 BCompare.exe。",
    );
  }
  const original = manifest.OriginalDirectory;
  const preview = path.join(run, "repair-preview");
  for (const directory of [original, preview]) {
    if (!(await exists(directory, "directory"))) throw new Error(`目录不存在：${directory}`);
  }
  const checkedConfiguration = new Map();
  for (const file of manifest.Files) {
    const source = path.join(original, file.RelativePath);
    const copy = path.join(preview, file.RelativePath);
    if ((await hashFile(source)) !== file.SourceSha256) {
      throw new Error(`原文已变化，请重新执行 Gate：${source}`);
    }
    if ((await hashFile(copy)) !== file.PreviewSha256) {
      throw new Error(`预览已变化，请重新执行 Gate：${copy}`);
    }
    for (const dependency of file.Configuration?.Files ?? []) {
      if (!checkedConfiguration.has(dependency.Path)) {
        if (!(await exists(dependency.Path, "file"))) {
          throw new Error(`配置文件已变化，请重新执行 Gate：${dependency.Path}`);
        }
        checkedConfiguration.set(dependency.Path, await hashFile(dependency.Path));
      }
      if (checkedConfiguration.get(dependency.Path) !== dependency.Sha256) {
        throw new Error(`配置或插件已变化，请重新执行 Gate：${dependency.Path}`);
      }
    }
  }
  console.log(`原始目录：${original}`);
  console.log(`修复预览：${preview}`);
  const isolated = manifest.Files.filter((file) =>
    ["UNSTABLE_FORMAT", "CONFIGURATION_MISMATCH", "UNCHANGED_FORMAT_ERROR"].includes(
      file.PreviewStatus,
    ),
  );
  if (isolated.length) {
    console.warn(
      `${isolated.length} 篇预览已隔离并保留原文副本；请查看 diagnosis.md 的独立清单，GUI 无差异不代表通过。`,
    );
  }
  if (options.CheckOnly) return 0;

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<BCSessions Version="1" MinVersion="1">',
    `  <TDirCompareSession Value="${escapeXml(manifest.SessionName)}">`,
    "    <Filters>",
    `      <NameFilter Value="${escapeXml(manifest.NameFilters)}" />`,
    "    </Filters>",
    "    <Rules>",
    '      <UseContentComparison Value="True" />',
    '      <ExpandAllOnLoad Value="True" />',
    '      <ContentCompareSkipSame Value="False" />',
    "    </Rules>",
    "    <Specs>",
    `      <Left Value="${escapeXml(original)}" />`,
    `      <Right Value="${escapeXml(preview)}" />`,
    "    </Specs>",
    "    <State>",
    '      <DirHandling Value="dirCompareFilesOnly" />',
    "    </State>",
    "  </TDirCompareSession>",
    "</BCSessions>",
  ].join("\n");
  const packagePath = path.join(run, "comparison.bcpkg");
  await fs.writeFile(packagePath, zipSingleFile("BCSessions.xml", xml));

  const importer = spawn(beyondCompare, ["/silent", packagePath], {
    stdio: "ignore",
    windowsHide: true,
  });
  const importCode = await waitForExit(importer, 15000, "Beyond Compare 导入会话超时。");
  if (importCode !== 0) throw new Error(`导入会话失败：${importCode}`);

  const launcher = spawn(
    beyondCompare,
    ["/expandall", `/filters=${manifest.NameFilters}`, manifest.SessionName],
    {
      stdio: "ignore",
      windowsHide: false,
      detached: true,
    },
  );
  await new Promise((resolve, reject) => {
    launcher.once("spawn", resolve);
    launcher.once("error", reject);
  });
  launcher.unref();
  return 0;
}

try {
  process.exitCode = await main();
} catch (failure) {
  console.error(`[ERROR] ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
