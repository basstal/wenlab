import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson, sha256File, writeJson } from "./AuditRuntime.mjs";
import { getAutoCorrectFindings, getCSpellFindings } from "./Findings.mjs";

export function toAuditCodeSpan(text) {
  const value = String(text ?? "");
  let length = 1;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const delimiter = "`".repeat(length);
  return `${delimiter} ${value.replace(/\r/g, "").replace(/\n/g, " ")} ${delimiter}`;
}

function quoteSingle(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function formatSeconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

export async function createReviewArtifacts(summary, run, scope, timeoutSeconds, runtime) {
  const sourceRoot = (await pathExists(scope, "file")) ? path.dirname(scope) : scope;
  const preview = path.join(run, "repair-preview");
  await fs.mkdir(preview, { recursive: true });
  const files = [];
  const plan = [];
  const expected = new Map();
  for (const result of summary.Results) {
    for (const item of result.ConfigurationRecords ?? []) {
      expected.set(item.File, item.Configuration?.Fingerprint);
    }
  }
  const formatter = await runtime.getNpmTool("prettier", "3.9.9");
  for (const file of summary.Files) {
    const source = path.join(summary.Root, file);
    const relative = path.relative(sourceRoot, source);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Preview path outside scope: ${file}`);
    }
    const target = path.join(preview, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    plan.push({
      File: file,
      Source: source,
      Target: target,
      RelativePath: relative,
      SourceSha256: await sha256File(source),
      ExpectedFingerprint: expected.get(file),
    });
  }
  const requestPath = path.join(run, "prettier-preview-request.json");
  await writeJson(requestPath, {
    PreviewRoot: preview,
    Config: path.join(runtime.configRoot, ".prettierrc.json"),
    IgnorePath: path.join(runtime.configRoot, ".prettierignore"),
    Files: plan,
  });
  const batchTimeout = Math.min(timeoutSeconds * Math.max(plan.length, 1), 3_600 * 128);
  const formatted = await runtime.runProfiled({
    command: formatter.command,
    args: [
      path.join(runtime.packageRoot, "Format-Previews.mjs"),
      requestPath,
    ],
    timeoutSeconds: batchTimeout,
    cwd: summary.Root,
    tool: "prettier",
    phase: "preview-batch",
    files: summary.Files,
  });
  await fs.writeFile(path.join(run, "prettier-preview.log"), formatted.stderr, "utf8");
  if (formatted.timedOut || formatted.exitCode !== 0) {
    throw new Error(
      `Preview batch failed (exit ${formatted.exitCode}, timeout ${formatted.timedOut}); see prettier-preview.log.`,
    );
  }
  await fs.writeFile(path.join(run, "prettier-preview.json"), formatted.stdout, "utf8");
  const records = JSON.parse(formatted.stdout.replace(/^\uFEFF/, ""));
  if (!Array.isArray(records) || records.length !== plan.length) {
    throw new Error("Preview batch returned an incomplete file inventory.");
  }
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    const record = records[index];
    if (
      record.File !== entry.File ||
      !["FORMATTED", "UNCHANGED_FORMAT_ERROR", "UNSTABLE_FORMAT", "CONFIGURATION_MISMATCH"].includes(
        record.PreviewStatus,
      )
    ) {
      throw new Error("Invalid preview batch result.");
    }
    if ((await sha256File(entry.Source)) !== entry.SourceSha256) {
      throw new Error(`Source changed during preview: ${entry.File}`);
    }
    const previewHash = await sha256File(entry.Target);
    files.push({
      File: entry.File,
      RelativePath: entry.RelativePath,
      SourceSha256: entry.SourceSha256,
      PreviewSha256: previewHash,
      PreviewStatus: record.PreviewStatus,
      Changed: entry.SourceSha256 !== previewHash,
      Configuration: record.Configuration,
      SecondPassPerformed: record.SecondPassPerformed,
      Stability: record.Stability,
      Error: record.Error,
    });
    if (runtime.profilerEnabled) {
      runtime.profileCalls.push({
        Tool: "prettier",
        Phase: "preview",
        File: entry.File,
        Files: [entry.File],
        Executable: "Prettier API",
        DurationMs: record.DurationMs,
        ExitCode: record.PreviewStatus === "FORMATTED" ? 0 : 2,
        TimedOut: false,
        Error: record.Error,
      });
    }
  }
  const beyondCompare = await readJson(path.join(runtime.configRoot, "beyond-compare.json"));
  const nameFilters = (await pathExists(scope, "file")) ? path.basename(scope) : "*.md";
  const manifest = {
    Version: 1,
    Gate: summary.Gate,
    OriginalDirectory: sourceRoot,
    NameFilters: nameFilters,
    SessionName: `wenlab-audit-${summary.Gate}-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    BeyondCompareExecutable: beyondCompare.executable,
    Files: files,
  };
  await writeJson(path.join(run, "comparison.json"), manifest);
  await fs.copyFile(
    path.join(runtime.packageRoot, "Open-Comparison.mjs"),
    path.join(run, "Open-Comparison.mjs"),
  );
  return {
    Status: "READY",
    Report: "diagnosis.md",
    Preview: "repair-preview",
    Manifest: "comparison.json",
    Launcher: "Open-Comparison.mjs",
    Files: files,
    UnstableFiles: files.filter((file) => file.PreviewStatus === "UNSTABLE_FORMAT"),
    RejectedFiles: files.filter((file) => file.PreviewStatus !== "FORMATTED"),
  };
}

function addConfigurationSection(summary, lines, runtime) {
  lines.push("", "## 配置与警告", "", "### 警告", "");
  if (summary.Warnings?.length) {
    for (const warning of summary.Warnings) lines.push(`- ${warning}`);
  } else {
    lines.push("无。");
  }
  lines.push("", "### 应用的配置", "");
  if (summary.Root) {
    lines.push(`- 项目根目录：\`${summary.Root}\``);
    lines.push(`- 项目级配置目录：\`${path.join(summary.Root, ".wenlab")}\``);
  }
  if (summary.ScanMode === "git") {
    lines.push(
      "- 文件清单：范围是 Git 仓库根目录，按 Git 规则收集已跟踪及未被忽略的 Markdown，并按排除规则跳过匹配的目录和文件。",
    );
  } else if (summary.ScanMode === "recursive") {
    lines.push(
      "- 文件清单：递归收集范围内的所有 Markdown（包括被 Git 忽略的文件），跳过 `.git`、`node_modules`、`exclude` 规则匹配项和报告输出目录。",
    );
  }
  if (summary.Exclusions) {
    const describe = (items) => (items?.length ? items.map((item) => `\`${item}\``).join("、") : "无");
    lines.push(`- 项目排除：${describe(summary.Exclusions.Project)}`);
    lines.push(`- 本次生效的排除规则：${describe(summary.Exclusions.Applied)}`);
  }
  if (summary.Dictionary?.Base) {
    lines.push("- CSpell 词典：");
    lines.push(`  - wenlab 词典（兜底）：\`${summary.Dictionary.Base}\``);
    if (summary.Dictionary.ProjectIsBase) {
      lines.push("  - 项目词典：与 wenlab 词典相同（审计 wenlab 自身）");
    } else if (summary.Dictionary.Project) {
      lines.push(
        `  - 项目词典：\`${summary.Dictionary.Project}\`${summary.Dictionary.ProjectFound ? "" : "（不存在，未使用）"}`,
      );
    }
    if (summary.Dictionary.Extra) {
      lines.push(`  - 附加词典（-Dictionary）：\`${summary.Dictionary.Extra}\``);
    }
  }
  if (summary.ProjectConfig) {
    if (summary.ProjectConfig.Found) {
      lines.push(`- 项目审计配置：\`${summary.ProjectConfig.Path}\``);
      lines.push(
        `  - 排除规则：${summary.ProjectConfig.Exclude?.length ? summary.ProjectConfig.Exclude.join("、") : "无"}`,
      );
      lines.push(
        `  - rumdl 额外关闭的规则：${summary.ProjectConfig.RumdlDisable?.length ? summary.ProjectConfig.RumdlDisable.join("、") : "无"}`,
      );
      if (summary.ProjectConfig.LycheeExclude?.length) {
        lines.push("  - lychee 排除的链接（正则）：");
        for (const pattern of summary.ProjectConfig.LycheeExclude) lines.push(`    - \`${pattern}\``);
      } else {
        lines.push("  - lychee 排除的链接：无");
      }
      lines.push(
        `  - Vale 关闭的规则：${summary.ProjectConfig.ValeDisable?.length ? summary.ProjectConfig.ValeDisable.join("、") : "无"}`,
      );
      lines.push(`  - 文件名检查：${summary.ProjectConfig.FileNames ? "已启用" : "未启用"}`);
    } else {
      lines.push(
        `- 项目审计配置：未提供（\`${summary.ProjectConfig.Path}\` 不存在），使用默认规则。`,
      );
    }
  }
  if (summary.Review?.UnstableFiles) {
    lines.push(
      "- Prettier：检查与预览统一启用 EditorConfig，并对比配置指纹。逐文件有效选项、配置与本地插件的 SHA256 指纹见 [prettier-check.json](prettier-check.json)、[prettier-preview.json](prettier-preview.json) 和 [comparison.json](comparison.json)。",
    );
  }
  lines.push(`- 各工具的基础配置：\`${path.resolve(runtime.configRoot)}\``);
}

async function addFindingSections(summary, run, lines) {
  const names = {
    filenames: "文件名",
    autocorrect: "AutoCorrect",
    rumdl: "rumdl",
    cspell: "CSpell",
    prettier: "Prettier",
    vale: "Vale",
    "lychee-local": "lychee-local",
    "lychee-online": "lychee-online",
  };
  lines.push("", "## 定位与修复建议", "");
  for (const result of summary.Results) {
    lines.push("", `### ${names[result.Tool] ?? result.Tool}`, "");
    let findings = [...(result.Findings ?? [])];
    const logPath = result.Log ? path.join(run, result.Log) : null;
    if (
      !findings.length &&
      result.Status !== "PASS" &&
      logPath &&
      (await pathExists(logPath, "file"))
    ) {
      const logText = await fs.readFile(logPath, "utf8");
      if (result.Tool === "autocorrect") findings = getAutoCorrectFindings(logText);
      if (result.Tool === "cspell") findings = getCSpellFindings(logText);
    }
    if (result.Status === "PASS" && !findings.length) {
      lines.push("通过，未发现问题。");
      continue;
    }
    let hasDetails = false;
    if (result.Tool === "filenames") {
      if (findings.length) {
        lines.push(
          "文件名只能使用字母、数字、中文和连词线，单词之间用连词线分隔，不含空格、点和下划线。重命名后同步更新指向它的链接。",
          "",
        );
      }
      for (const finding of findings) {
        lines.push(`- ${toAuditCodeSpan(finding.File)}：${(finding.Problems ?? []).join("；")}`);
      }
      hasDetails = findings.length > 0;
    } else if (result.Tool === "autocorrect") {
      if (findings.length) {
        lines.push(
          "核对以下混排空格或标点建议；确认符合原文含义后应用，再重跑 Gate。Prettier 预览不包含这些修改。",
          "",
        );
      }
      for (const finding of findings) {
        lines.push(
          `- ${toAuditCodeSpan(`${finding.File}:${finding.Line}:${finding.Column}`)} 原文：${toAuditCodeSpan(finding.Old)}；建议：${toAuditCodeSpan(finding.New)}`,
        );
      }
      hasDetails = findings.length > 0;
    } else if (result.Tool === "cspell") {
      if (findings.length) {
        lines.push("逐项核对未知词：拼写错误修改原文，确为专有名词才加入词典，不批量接受未知词。", "");
      }
      for (const finding of findings) {
        lines.push(
          `- ${toAuditCodeSpan(`${finding.File}:${finding.Line}:${finding.Column}`)} 未识别词：${toAuditCodeSpan(finding.Word)}`,
        );
      }
      hasDetails = findings.length > 0;
    } else if (result.Tool === "rumdl") {
      if (findings.length) {
        lines.push("按具体规则核对标题层级、列表、空行、链接或围栏结构；涉及文档含义的调整需人工确认。", "");
      }
      for (const finding of findings) {
        lines.push(
          `- ${toAuditCodeSpan(`${finding.file}:${finding.line}:${finding.column}`)} **${finding.rule}**：${finding.message}`,
        );
      }
      hasDetails = findings.length > 0;
    } else if (result.Tool === "prettier") {
      for (const finding of findings) {
        const advice =
          finding.Status === "FAIL"
            ? "格式与当前配置不一致，请审阅稳定修复预览。被隔离文件应先处理上方异常清单，不能应用 y、z 诊断副本。"
            : finding.Message;
        lines.push(`- ${toAuditCodeSpan(finding.File)} **${finding.Status}**：${advice}`);
      }
      hasDetails = findings.length > 0;
    } else if (result.Tool === "vale") {
      for (const finding of findings) {
        lines.push(
          `- ${toAuditCodeSpan(`${finding.file}:${finding.line}:${finding.column}`)} **${finding.rule}**：${finding.message}`,
        );
      }
      hasDetails = findings.length > 0;
      for (const fileError of result.FileErrors ?? []) {
        lines.push(
          `- ${toAuditCodeSpan(fileError.File)} **执行错误**：${fileError.Message}；先修复该文件的解析或执行问题，再重跑 Vale。`,
        );
        hasDetails = true;
      }
    } else if (result.Tool === "lychee-local" || result.Tool === "lychee-online") {
      for (const finding of findings) {
        const status = toAuditCodeSpan(JSON.stringify(finding.Status));
        const advice =
          finding.Category === "REVIEW"
            ? "人工复核权限、限流、证书、网络或超时原因，不能将结果视为通过。"
            : /^https?:\/\//.test(finding.Url)
              ? "核对目标是否删除或迁移，修正 URL 后重跑链接检查。"
              : "核对目标文件、相对路径及锚点，修正链接后重跑离线检查。";
        lines.push(
          `- ${toAuditCodeSpan(finding.Source)} → ${toAuditCodeSpan(finding.Url)} **${finding.Category}**，状态：${status}；建议：${advice}`,
        );
      }
      hasDetails = findings.length > 0;
    }
    if (result.Message) lines.push("", `执行说明：${result.Message}`);
    if (!hasDetails) {
      lines.push(`状态为 ${result.Status}，未获得可解析的问题位置。请先核对原始日志与执行说明，不能视为通过。`);
    }
    if (result.Log) lines.push("", `原始证据：[${result.Log}](${result.Log})。`);
  }
}

export async function writeAuditDiagnosis(summary, run, runtime) {
  const lines = [];
  const gateTitle = summary.GateName ? `${summary.GateName}（${summary.Gate}）` : `${summary.Gate} `;
  lines.push(`# ${gateTitle}Markdown 诊断与修复建议`, "");
  lines.push(
    `检查时间（UTC）：${summary.TimestampUtc}。范围：\`${summary.Scope}\`，共 ${summary.Files.length} 篇。结果：**${summary.Status}**，退出码 ${summary.ExitCode}。`,
    "",
    "| 检查 | 版本 | 状态 | 详细证据 |",
    "| --- | --- | --- | --- |",
  );
  for (const result of summary.Results) {
    const version = result.Version ?? "—";
    const evidence = result.Log ? `[${result.Tool}.log](${result.Log})` : "见 summary.json";
    lines.push(`| ${result.Tool} | ${version} | ${result.Status} | ${evidence} |`);
  }
  for (const result of summary.Results) {
    if (result.Message) lines.push("", `执行说明（${result.Tool}）：${result.Message}`);
  }
  if (summary.Review?.UnstableFiles) {
    lines.push("", "## 格式不稳定文件清单（y 与 z 不同）", "");
    lines.push(
      "y = F(原文)，z = F(y)。以下文件不提供自动修复，repair-preview 中保留原文副本；GUI 中没有差异不代表已通过。y、z 仅用于诊断，不能当作安全修复应用。",
    );
    if (summary.Review.UnstableFiles.length) {
      lines.push("", "| 文件 | 状态 | 候选 y | 再次格式化 z |", "| --- | --- | --- | --- |");
      for (const file of summary.Review.UnstableFiles) {
        lines.push(
          `| ${file.File} | UNSTABLE_FORMAT | [查看 y](${file.Stability.Y}) | [查看 z](${file.Stability.Z}) |`,
        );
      }
    } else {
      lines.push("", "无。");
    }
    const otherRejected = (summary.Review.RejectedFiles ?? []).filter(
      (file) => file.PreviewStatus !== "UNSTABLE_FORMAT",
    );
    if (otherRejected.length) {
      lines.push("", "### 其他被隔离的预览", "");
      for (const file of otherRejected) {
        lines.push(`- \`${file.File}\` **${file.PreviewStatus}**：${file.Error}`);
      }
    }
  }
  if (summary.Profile?.Enabled) {
    lines.push("", "## 耗时统计", "");
    lines.push(
      `审计及审阅包总耗时：${formatSeconds(summary.Profile.DurationMs)} 秒；其中审阅包生成：${formatSeconds(summary.Profile.ReviewArtifactsMs)} 秒。`,
    );
    const checksMs = summary.Results.reduce(
      (sum, result) => sum + (typeof result.DurationMs === "number" ? result.DurationMs : 0),
      0,
    );
    const otherMs = summary.Profile.DurationMs - checksMs - summary.Profile.ReviewArtifactsMs;
    lines.push(
      "",
      `耗时核对：检测合计 ${formatSeconds(checksMs)} 秒 + 审阅包生成 ${formatSeconds(summary.Profile.ReviewArtifactsMs)} 秒 + 其他编排耗时 ${formatSeconds(otherMs)} 秒 = 总计 ${formatSeconds(summary.Profile.DurationMs)} 秒。其他编排包括范围扫描、检查前后哈希核对、控制台输出及汇总准备。`,
      "",
      "以下为墙钟耗时。工具总耗时包含版本探测、逐文件检查与编排开销；审阅包耗时包含预览调用，不能重复相加。总耗时不含最终报告序列化和落盘。",
      "",
      "| 检查 | 总耗时（秒） |",
      "| --- | ---: |",
    );
    for (const result of summary.Results) {
      if (typeof result.DurationMs === "number") {
        lines.push(`| ${result.Tool} | ${formatSeconds(result.DurationMs)} |`);
      }
    }
    lines.push(
      "",
      "| 工具 | 内部调用 | 次数 | 合计（秒） | 平均（毫秒） | 最小（毫秒） | 最大（毫秒） |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const statistic of summary.Profile.Statistics) {
      lines.push(
        `| ${statistic.Tool} | ${statistic.Phase} | ${statistic.Count} | ${formatSeconds(statistic.TotalMs)} | ${statistic.AverageMs.toFixed(3)} | ${statistic.MinMs.toFixed(3)} | ${statistic.MaxMs.toFixed(3)} |`,
      );
    }
    lines.push(
      "",
      "内部调用：`git-root` 为定位项目根目录，`git-scan`（范围是仓库根目录时）或 `file-scan`（其他范围）为收集文件清单，`version` 为版本探测，`check` 为逐文件或清单检测（各次文件清单见 profile.json 的 Files），`check-api` 为 Prettier 检查进程内逐文件耗时，`preview-batch` 为整个预览进程，`preview` 为其内部逐文件 API 与读写耗时。check-api 包含在 Prettier 的 check 中，preview 包含在 preview-batch 中，不能重复相加。失败、超时及启动异常的调用同样计时；批次退出码不代表每篇文档的结果。",
      "",
      "完整逐次调用耗时、文件、退出码和异常见 [profile.json](profile.json)，汇总同时保存于 [summary.json](summary.json)。",
    );
  }
  await addFindingSections(summary, run, lines);
  if (summary.Review?.Status !== "READY") {
    lines.push("", "预览未生成，请先解决依赖或预览生成故障，再执行 Gate。");
  }
  if (summary.ArchiveLinks?.length || summary.ArchiveLinksScanned) {
    lines.push("", "## 对归档文档的链接引用", "");
    if (summary.ArchiveLinks?.length) {
      lines.push("以下链接指向名为 archive 的目录（不区分大小写）下的归档文档。仅供核对，不影响检查结果。", "");
      for (const link of summary.ArchiveLinks) {
        lines.push(
          `- ${toAuditCodeSpan(`${link.File}:${link.Line}:${link.Column}`)} → ${toAuditCodeSpan(link.Target)}`,
        );
      }
    } else {
      lines.push("本次文档中没有指向归档文档的链接。");
    }
  }
  addConfigurationSection(summary, lines, runtime);
  if (summary.Review?.Status === "READY") {
    lines.push("", "## 打开 GUI 全量规则比对", "", "```text");
    lines.push(`node ${quoteSingle(path.join(run, summary.Review.Launcher))}`);
    lines.push("```");
  }
  const gatePath = path.join(runtime.packageRoot, `${summary.Gate}.mjs`);
  const scopePath = path.isAbsolute(summary.Scope)
    ? path.resolve(summary.Scope)
    : path.resolve(runtime.root, summary.Scope);
  const reportPath = path.resolve(run, "..", "..");
  lines.push("", `## 重新运行 ${summary.Gate} 审计`, "", "```text");
  let options = "";
  if (summary.Invocation?.TimeoutSeconds !== 180) {
    options += ` -TimeoutSeconds ${summary.Invocation.TimeoutSeconds}`;
  }
  if (summary.Invocation?.Profiler) options += " -Profiler";
  if (summary.Dictionary?.Extra) {
    options += ` -Dictionary ${quoteSingle(summary.Dictionary.Extra)}`;
  }
  lines.push(
    `node ${quoteSingle(gatePath)} -Path ${quoteSingle(scopePath)} -ReportDirectory ${quoteSingle(reportPath)}${options}`,
    "```",
  );
  await fs.writeFile(path.join(run, "diagnosis.md"), `${lines.join("\n")}\n`, "utf8");
}
