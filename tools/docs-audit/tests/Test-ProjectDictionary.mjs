import { createHash } from "node:crypto";
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
  writeFile,
} from "./TestSupport.mjs";

const { project, id } = await createTempProject("wenlab-audit-dictionary");
const output = path.join(repoRoot, ".tmp", "docs-audit", "node-tests", "dictionary", id);
const toolDictionary = path.join(repoRoot, ".wenlab", "dictionary.txt");
const toolDictionaryHash = createHash("sha256")
  .update(await fs.readFile(toolDictionary))
  .digest("hex");
const projectDictionary = path.join(project, ".wenlab", "dictionary.txt");
const extraDictionary = path.join(project, "config", "words.txt");

async function invokeCase(name, { expectedExit, expectWarning, dictionary } = {}) {
  const code = await invokeDocsAudit({
    gate: "LocalGate",
    path: path.join(project, "docs"),
    reportDirectory: path.join(output, name),
    dictionary,
  });
  const report = await latestSummary(path.join(output, name, "LocalGate"));
  assertEqual(code, expectedExit, `${name} exit code`);
  const warnings = report.summary.Warnings.filter((warning) => warning.startsWith("项目词典不存在"));
  assertEqual(warnings.length, expectWarning ? 1 : 0, `${name} missing-dictionary warning`);
  if (expectWarning) {
    assert(report.diagnosis.includes("项目词典不存在"), `${name} diagnosis omits the warning.`);
  }
  assert(
    report.diagnosis.includes(`wenlab 词典（兜底）：\`${toolDictionary}\``),
    `${name} diagnosis omits the wenlab dictionary.`,
  );
  const section = report.diagnosis.indexOf("## 配置与警告");
  const gui = report.diagnosis.indexOf("## 打开 GUI 全量规则比对");
  const next = gui >= 0 ? gui : report.diagnosis.indexOf("## 重新运行");
  assert(
    section >= 0 &&
      section < next &&
      report.diagnosis.indexOf("## 定位与修复建议") < section,
    `${name} diagnosis does not place settings and warnings before the GUI section.`,
  );
  return report;
}

try {
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.mkdir(path.join(project, "config"), { recursive: true });
  await initGit(project);
  await writeFile(
    path.join(project, "docs", "readme.md"),
    "# Readme\n\nThe rumdl check accepts Zyxwvutq and Qwvbnmlk.\n",
  );

  const none = await invokeCase("none", { expectedExit: 1, expectWarning: true });
  const cspell = none.summary.Results.find((result) => result.Tool === "cspell");
  assertEqual(cspell.Status, "FAIL", "Missing project dictionary should fail spelling.");
  assertEqual(none.summary.Results.length, 7, "Every LocalGate check should run.");
  console.log("PASS: missing project dictionary warns and the audit continues");

  await writeFile(extraDictionary, "Zyxwvutq\nQwvbnmlk\n");
  await invokeCase("extra-only", {
    expectedExit: 0,
    expectWarning: true,
    dictionary: "config/words.txt",
  });
  console.log("PASS: -Dictionary is added without a project dictionary");

  await writeFile(projectDictionary, "Zyxwvutq\nQwvbnmlk\n");
  const projectCase = await invokeCase("project", {
    expectedExit: 0,
    expectWarning: false,
  });
  assert(
    projectCase.diagnosis.includes(`项目词典：\`${projectDictionary}\``),
    "Diagnosis does not show the project dictionary.",
  );
  console.log("PASS: .wenlab/dictionary.txt is used with the wenlab dictionary");

  await writeFile(projectDictionary, "Zyxwvutq\n");
  await writeFile(extraDictionary, "Qwvbnmlk\n");
  const projectHash = createHash("sha256").update(await fs.readFile(projectDictionary)).digest("hex");
  const both = await invokeCase("both", {
    expectedExit: 0,
    expectWarning: false,
    dictionary: "config/words.txt",
  });
  assertEqual(
    both.summary.Dictionary.Extra,
    path.resolve(extraDictionary),
    "Relative -Dictionary did not resolve against the project root.",
  );
  assert(
    both.diagnosis.includes(`-Dictionary '\`${path.resolve(extraDictionary)}\``) ||
      both.diagnosis.includes(`-Dictionary '${path.resolve(extraDictionary)}'`),
    "Rerun command omits -Dictionary.",
  );
  assertEqual(
    createHash("sha256").update(await fs.readFile(projectDictionary)).digest("hex"),
    projectHash,
    "Audit modified the project dictionary.",
  );
  console.log("PASS: -Dictionary is appended without replacing other dictionaries");

  const missing = await invokeCase("missing", {
    expectedExit: 2,
    expectWarning: false,
    dictionary: "config/absent.txt",
  });
  assert(
    missing.summary.Results.find((result) => result.Tool === "orchestrator")?.Message?.match(
      /Dictionary not found/,
    ),
    "Missing -Dictionary did not fail closed.",
  );
  console.log("PASS: missing -Dictionary file returns ERROR");

  const selfReport = path.join(output, "self");
  const selfCode = await invokeDocsAudit({
    gate: "LocalGate",
    path: path.join(repoRoot, "tools", "docs-audit", "tests", "fixtures", "pass.md"),
    reportDirectory: selfReport,
  });
  const self = await latestSummary(path.join(selfReport, "LocalGate"));
  assertEqual(selfCode, 0, "Self audit should pass.");
  assertEqual(self.summary.Warnings.length, 0, "Self audit should not warn.");
  assert(self.summary.Dictionary.ProjectIsBase, "Self audit should use the wenlab dictionary once.");
  console.log("PASS: wenlab self-audit uses .wenlab/dictionary.txt once and does not warn");

  assertEqual(
    createHash("sha256").update(await fs.readFile(toolDictionary)).digest("hex"),
    toolDictionaryHash,
    "Audit modified the wenlab dictionary.",
  );
} finally {
  await cleanupTempProject(project, "wenlab-audit-dictionary", id);
}

console.log("Project dictionary tests PASS.");
