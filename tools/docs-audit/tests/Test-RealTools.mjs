import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  getCSpellFindings,
  getLinkFindings,
  invokeDocsAudit,
} from "../DocsAudit.mjs";
import {
  createRuntime,
  defaultResolveExecutable,
  readJson,
  runProcessReal,
  writeJson,
} from "../AuditRuntime.mjs";
import {
  assert,
  assertEqual,
  cleanupTempProject,
  createTempProject,
  latestSummary,
  repoRoot,
  run,
  testReportPath,
  writeFile,
} from "./TestSupport.mjs";

const configRoot = path.join(repoRoot, ".wenlab");
const runtime = createRuntime();
const vale = await defaultResolveExecutable("vale");
const rumdl = await defaultResolveExecutable("rumdl");
const autocorrect = await defaultResolveExecutable("autocorrect");
const lychee = await defaultResolveExecutable("lychee");
const cspell = await runtime.getNpmTool("cspell", "10.3.6");

async function invoke(command, args, cwd, timeoutSeconds = 30) {
  return await runProcessReal({ command, args, cwd, timeoutSeconds });
}

function flattenVale(report) {
  return Object.values(report ?? {}).flat();
}

const dependencies = await run(
  process.execPath,
  [path.join(repoRoot, "tools", "docs-audit", "Check-Dependencies.mjs")],
  { cwd: repoRoot },
);
assertEqual(dependencies.code, 0, `Dependency check failed: ${dependencies.stderr}`);
console.log("PASS: Node.js, Git, npm dependencies and native tools are available");

const fixtureReport = testReportPath("real-fixtures");
const fixtureCode = await invokeDocsAudit({
  gate: "RemoteGate",
  path: path.join(repoRoot, "tools", "docs-audit", "tests", "fixtures", "pass.md"),
  reportDirectory: fixtureReport,
});
assertEqual(fixtureCode, 0, "Real RemoteGate fixture pass failed");
console.log("PASS: real Local/Remote Gate checks the fixture scope");

const { project, id } = await createTempProject("wenlab-audit-real-tools");
try {
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  const badTerms = path.join(project, "terms-bad.md");
  await writeFile(
    badTerms,
    "# Terms\n\nGithub NodeJS Powershell Typescript Javascript\n",
  );
  const badTermsResult = await invoke(
    vale,
    ["--config", path.join(configRoot, ".vale.ini"), "--output=JSON", "--", badTerms],
    project,
  );
  assertEqual(badTermsResult.exitCode, 1, "Vale should reject the five wrong brand spellings");
  const termAlerts = flattenVale(JSON.parse(badTermsResult.stdout));
  assertEqual(termAlerts.length, 5, "Vale should report all five brand spellings");
  assert(
    termAlerts.every((alert) => alert.Check === "Wenlab.Terms"),
    "Vale brand findings must use Wenlab.Terms",
  );

  const goodTerms = path.join(project, "terms-good.md");
  await writeFile(
    goodTerms,
    "# Terms\n\n台风登陆，登陆作战。产品字段名为「帐户」。GitHub、Node.js、PowerShell、TypeScript 和 JavaScript 写法正确，`powershell.exe` 是命令。\n",
  );
  const goodTermsResult = await invoke(
    vale,
    ["--config", path.join(configRoot, ".vale.ini"), "--output=JSON", "--", goodTerms],
    project,
  );
  assertEqual(goodTermsResult.exitCode, 0, "Vale should accept correct brands and contextual Chinese");
  console.log("PASS: real Vale applies brand rules without over-correcting Chinese words");

  // AbsolutePaths was removed from format-quality checks; absolute path
  // usage is now reviewed in the semantic content/editorial pass, not by Vale.
  const pathDocument = path.join(project, "paths.md");
  await writeFile(
    pathDocument,
    [
      "# Paths",
      "",
      "See C:\\abs\\a.md and /docs/guide.md.",
      "",
      "A relative path such as guide.md is allowed.",
      "",
      "Use \`C:\\inline\\a.md\` in code.",
      "",
      "\`\`\`text",
      "D:\\code\\a.md",
      "\`\`\`",
      "",
    ].join("\n"),
  );
  const pathResult = await invoke(
    vale,
    ["--config", path.join(configRoot, ".vale.ini"), "--output=JSON", "--", pathDocument],
    project,
  );
  assertEqual(pathResult.exitCode, 0, "Vale should no longer report absolute paths");
  const pathAlerts = flattenVale(JSON.parse(pathResult.stdout));
  assertEqual(
    pathAlerts.filter((alert) => alert.Check === "Wenlab.AbsolutePaths").length,
    0,
    "AbsolutePaths rule must be gone from the Wenlab rule set",
  );
  console.log("PASS: absolute paths are no longer reported by the format-quality Gate");

  // AbsolutePaths removed from format quality: root-relative links no longer
  // fail through Vale. Their target existence is still checked by lychee.
  const rootLinkProject = path.join(project, "root-link");
  await writeFile(path.join(rootLinkProject, "docs", "guide.md"), "# Guide\n\nText.\n");
  await writeFile(
    path.join(rootLinkProject, "root.md"),
    "# Root\n\nSee [guide](/docs/guide.md).\n",
  );
  const rootLinkReport = testReportPath("root-link");
  const rootLinkCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: rootLinkProject,
    reportDirectory: rootLinkReport,
  });
  assertEqual(rootLinkCode, 0, "Existing root-relative links pass LocalGate without Vale");
  await writeFile(
    path.join(rootLinkProject, "broken.md"),
    "# Broken\n\nSee [absent](/docs/absent.md).\n",
  );
  const rootLinkReport2 = testReportPath("root-link-missing");
  const rootLinkCode2 = await invokeDocsAudit({
    gate: "LocalGate",
    path: rootLinkProject,
    reportDirectory: rootLinkReport2,
  });
  const rootLinkSummary2 = await latestSummary(path.join(rootLinkReport2, "LocalGate"));
  assertEqual(rootLinkCode2, 1, "Missing root-relative targets should fail LocalGate");
  assertEqual(
    rootLinkSummary2.summary.Results.find((result) => result.Tool === "lychee-local")?.Status,
    "FAIL",
    "Missing root-relative link targets must be reported by lychee",
  );
  const rootVale = rootLinkSummary2.summary.Results.find((result) => result.Tool === "vale");
  assert(
    (rootVale?.Findings ?? []).every((finding) => finding.Check !== "Wenlab.AbsolutePaths"),
    "Vale findings must not reference AbsolutePaths",
  );
  console.log("PASS: root-relative link targets are checked by lychee, not Vale");

  const valeCase = path.join(project, "vale-case");
  await writeFile(path.join(valeCase, "a-frontmatter.md"), "---\nkey: [unclosed\n---\n\n# Broken\n");
  await writeFile(path.join(valeCase, "b-terms.markdown"), "# Terms\n\nGithub\n");
  await writeFile(path.join(valeCase, "c-ok.md"), "# OK\n\nGitHub\n");
  await writeFile(path.join(valeCase, "c-path.md"), "# Path\n\nSee C:\\abs\\a.md.\n");
  const valeReport = testReportPath("vale-continuation");
  const valeCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: valeCase,
    reportDirectory: valeReport,
  });
  const valeSummary = await latestSummary(path.join(valeReport, "LocalGate"));
  const valeResult = valeSummary.summary.Results.find((result) => result.Tool === "vale");
  assertEqual(valeCode, 2, "A Vale document error should make the Gate ERROR");
  assertEqual(valeResult.FileErrors.length, 1, "Vale should record the broken YAML document");
  assertEqual(valeResult.Findings.length, 1, "Vale should continue and collect the later Terms finding");
  assert(
    valeSummary.diagnosis.includes("yaml: error") ||
      valeSummary.diagnosis.includes("unexpected end of stream") ||
      valeSummary.diagnosis.includes("执行错误"),
    "Diagnosis should include the Vale document error",
  );
  console.log("PASS: real Vale continues after a document error and reports all findings");

  const structure = path.join(project, "structure.md");
  await writeFile(structure, "# Test\n\n### Level\n\n```\ncode\n```\n");
  const structureResult = await invoke(
    rumdl,
    [
      "check",
      "--config",
      path.join(configRoot, "rumdl.toml"),
      "--no-code-block-tools",
      "--no-cache",
      "--deny-config-warnings",
      "--fail-on",
      "any",
      "--output-format",
      "json",
      "--color",
      "never",
      "--",
      structure,
    ],
    project,
  );
  assertEqual(structureResult.exitCode, 1, "rumdl should reject invalid structure");
  const structureRules = new Set(JSON.parse(structureResult.stdout).map((finding) => finding.rule));
  assert(structureRules.has("MD001"), "rumdl should report the heading jump.");
  assert(structureRules.has("MD040"), "rumdl should report the missing fence language.");

  const punctuatedHeadings = path.join(project, "heading-punctuation.md");
  await writeFile(
    punctuatedHeadings,
    [
      "# 标题",
      "",
      "## 句号。",
      "",
      "正文。",
      "",
      "## 逗号，",
      "",
      "正文。",
      "",
      "## 顿号、",
      "",
      "正文。",
      "",
      "## 分号；",
      "",
      "正文。",
      "",
      "## 冒号：",
      "",
      "正文。",
      "",
      "## 叹号！",
      "",
      "正文。",
      "",
      "## 问号？",
      "",
      "正文。",
      "",
    ].join("\n"),
  );
  const headingResult = await invoke(
    rumdl,
    [
      "check",
      "--config",
      path.join(configRoot, "rumdl.toml"),
      "--no-code-block-tools",
      "--no-cache",
      "--deny-config-warnings",
      "--fail-on",
      "any",
      "--output-format",
      "json",
      "--color",
      "never",
      "--",
      punctuatedHeadings,
    ],
    project,
  );
  assertEqual(headingResult.exitCode, 1, "rumdl should reject heading punctuation");
  const md026 = JSON.parse(headingResult.stdout).filter((finding) => finding.rule === "MD026");
  assertEqual(md026.length, 5, "MD026 should report five pause marks and allow ！ and ？");
  console.log("PASS: real rumdl reports structure and CJK heading punctuation");

  const compound = path.join(project, "compound.md");
  await writeFile(compound, "# 复合词\n\n氧化-还原反应。\n\n启动Windows系统。\n");
  const compoundResult = await invoke(
    autocorrect,
    [
      "--lint",
      "--strict",
      "--format",
      "json",
      "--config",
      path.join(configRoot, ".autocorrectrc"),
      "--",
      compound,
    ],
    project,
  );
  const autoMessages = JSON.parse(compoundResult.stdout).messages;
  const autoLines = autoMessages.flatMap((message) => message.lines ?? []);
  assertEqual(autoLines.length, 1, "AutoCorrect should only add spacing around Windows");
  assert(
    autoLines[0].new.includes("启动 Windows 系统") &&
      !autoLines[0].new.includes("氧化 - 还原"),
    "AutoCorrect should preserve compound-word hyphens",
  );
  console.log("PASS: real AutoCorrect preserves compound-word hyphens");

  const badSpell = path.join(project, "spell.md");
  await writeFile(badSpell, "# Test\n\nThisss izzz spelinggg.\n");
  const fileList = path.join(project, "spell-files.txt");
  await writeFile(fileList, `${badSpell}\n`);
  const spellResult = await invoke(
    cspell.command,
    [
      ...cspell.prefix,
      "lint",
      "--config",
      path.join(configRoot, "cspell.json"),
      "--no-progress",
      "--no-summary",
      "--file-list",
      fileList,
    ],
    project,
  );
  assertEqual(spellResult.exitCode, 1, "CSpell should fail on unknown words");
  assertEqual(
    getCSpellFindings(`${spellResult.stdout}\n${spellResult.stderr}`).length,
    3,
    "CSpell should report all unknown words",
  );

  const badFormat = path.join(project, "format.md");
  await writeFile(badFormat, "# Test\n\n-   text\n");
  const checkRequest = path.join(project, "check-request.json");
  await writeJson(checkRequest, {
    Config: path.join(configRoot, ".prettierrc.json"),
    IgnorePath: path.join(configRoot, ".prettierignore"),
    Files: [{ File: "format.md", Source: badFormat }],
  });
  const checkResult = await invoke(
    process.execPath,
    [path.join(repoRoot, "tools", "docs-audit", "Check-Markdown.mjs"), checkRequest],
    project,
  );
  assertEqual(checkResult.exitCode, 1, "Prettier API should fail on inconsistent formatting");
  assertEqual(JSON.parse(checkResult.stdout)[0].Status, "FAIL", "Prettier API result was not FAIL");
  console.log("PASS: real CSpell and Prettier failure exits are preserved");

  const missingLocal = path.join(project, "missing-local.md");
  await writeFile(missingLocal, "# Links\n\n[Missing](missing.md)\n\n[Anchor](#absent)\n");
  const localList = path.join(project, "local-files.txt");
  await writeFile(localList, `${missingLocal}\n`);
  const localJson = path.join(project, "local-links.json");
  const localResult = await invoke(
    lychee,
    [
      "--config",
      path.join(configRoot, "lychee.toml"),
      "--no-progress",
      "--format",
      "json",
      "--include-fragments",
      "--root-dir",
      project,
      "--offline",
      "--output",
      localJson,
      "--files-from",
      localList,
    ],
    project,
  );
  assertEqual(localResult.exitCode, 2, "lychee should fail missing local links");
  const localFindings = getLinkFindings(await readJson(localJson));
  assertEqual(localFindings.length, 2, "lychee should report the missing file and anchor");
  assert(
    localFindings.every((finding) => finding.Category === "FAIL"),
    "Local link failures must be FAIL",
  );
  console.log("PASS: real lychee reports missing local files and anchors");

  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const status = Number(request.url.slice(1));
    if (request.url === "/timeout") return;
    response.writeHead(Number.isFinite(status) ? status : 500, { "content-type": "text/plain" });
    response.end("response");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const httpDoc = path.join(project, "http.md");
    const httpList = path.join(project, "http-files.txt");
    await writeFile(httpList, `${httpDoc}\n`);
    const cases = [
      [401, "REVIEW"],
      [403, "REVIEW"],
      [429, "REVIEW"],
      [500, "REVIEW"],
      [404, "FAIL"],
      [410, "FAIL"],
    ];
    for (const [status, expected] of cases) {
      await writeFile(httpDoc, `# Links\n\n[Test](http://127.0.0.1:${port}/${status})\n`);
      const outputPath = path.join(project, `http-${status}.json`);
      const result = await invoke(
        lychee,
        [
          "--config",
          path.join(configRoot, "lychee.toml"),
          "--no-progress",
          "--format",
          "json",
          "--include-fragments",
          "--root-dir",
          project,
          "--output",
          outputPath,
          "--files-from",
          httpList,
        ],
        project,
      );
      assertEqual(result.exitCode, 2, `lychee should fail HTTP ${status}`);
      const findings = getLinkFindings(await readJson(outputPath));
      assertEqual(findings.length, 1, `lychee should report HTTP ${status}`);
      assertEqual(findings[0].Category, expected, `HTTP ${status} category`);
      console.log(`PASS: real HTTP ${status} -> ${expected}`);
    }

    await writeFile(httpDoc, `# Links\n\n[Test](http://127.0.0.1:${port}/timeout)\n`);
    const timeoutOutput = path.join(project, "http-timeout.json");
    const timeoutResult = await invoke(
      lychee,
      [
        "--config",
        path.join(configRoot, "lychee.toml"),
        "--no-progress",
        "--format",
        "json",
        "--include-fragments",
        "--root-dir",
        project,
        "--timeout",
        "1",
        "--max-retries",
        "0",
        "--output",
        timeoutOutput,
        "--files-from",
        httpList,
      ],
      project,
    );
    assertEqual(timeoutResult.exitCode, 2, "lychee should fail a timed-out request");
    const timeoutFindings = getLinkFindings(await readJson(timeoutOutput));
    assertEqual(timeoutFindings.length, 1, "lychee should report the timeout");
    assertEqual(timeoutFindings[0].Category, "REVIEW", "Timeouts must be REVIEW");
    console.log("PASS: real HTTP timeout -> REVIEW");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await cleanupTempProject(project, "wenlab-audit-real-tools", id);
}

console.log("Real integration tests PASS.");
