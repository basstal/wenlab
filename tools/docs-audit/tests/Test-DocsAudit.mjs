import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverAuditScope,
  getAuditFileBatches,
  invokeDocsAudit,
} from "../DocsAudit.mjs";
import {
  createRuntime,
  defaultResolveExecutable,
  runProcessReal,
} from "../AuditRuntime.mjs";
import {
  assert,
  assertEqual,
  latestSummary,
  repoRoot,
  testReportPath,
} from "./TestSupport.mjs";

const valeAlert = {
  Check: "Wenlab.Terms",
  Message: "simulated term alert",
  Severity: "error",
  Line: 3,
  Span: [1, 6],
  Match: "Github",
};

function createHarness(scenario) {
  const calls = [];
  let valeCalls = 0;
  const runtimeOptions = {
    async resolveExecutable(name) {
      if (name === "git") return await defaultResolveExecutable("git");
      if (scenario === "missing" && name === "vale") throw new Error("Simulated missing vale");
      return `mock-${name}`;
    },
    async getNpmTool(packageName, version) {
      return { command: `mock-${packageName}`, prefix: [], version };
    },
    async runProcess({ command, args, timeoutSeconds, cwd }) {
      if (!command.startsWith("mock-")) {
        return await runProcessReal({ command, args, timeoutSeconds, cwd });
      }
      const tool = command.slice(5);
      if (args.includes("--version")) {
        const versions = {
          autocorrect: "AutoCorrect 2.16.3",
          rumdl: "rumdl 0.3.0",
          vale: "vale version v3.24.0",
          lychee: "lychee 0.24.2",
        };
        return {
          exitCode: 0,
          stdout: versions[tool] ?? `${tool} mock-version`,
          stderr: "",
          timedOut: false,
        };
      }
      calls.push({ Tool: tool, Arguments: args, TimeoutSeconds: timeoutSeconds });
      const response = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (tool === "rumdl") response.stdout = "[]";
      if (tool === "autocorrect") response.stdout = '{"count":0,"messages":[]}';
      if (tool === "vale") {
        valeCalls += 1;
        response.stdout = "{}";
        if (scenario === "valeFileError" && valeCalls === 1) {
          response.exitCode = 2;
          response.stderr = JSON.stringify({
            Line: 1,
            Path: args.at(-1),
            Text: "yaml: simulated frontmatter error",
            Code: "E201",
            Span: 1,
          });
        } else if (
          (scenario === "valeFileError" && valeCalls === 2) ||
          (scenario === "valeAlerts" && valeCalls === 1)
        ) {
          response.exitCode = 1;
          response.stdout = JSON.stringify({ [args.at(-1)]: [valeAlert] });
        }
      }
      if ((scenario === "quality" || scenario === "reviewAndQuality") && tool === "cspell") {
        response.exitCode = 1;
      }
      if (scenario === "runtime" && tool === "prettier") response.exitCode = 2;
      if (scenario === "timeout" && tool === "cspell") response.timedOut = true;
      if (scenario === "launchError" && tool === "cspell") {
        throw new Error("Simulated process start failure");
      }
      if (scenario === "precedence" && tool === "cspell") response.exitCode = 1;
      if (scenario === "precedence" && tool === "prettier") response.exitCode = 2;

      if (tool === "prettier" && args.some((argument) => argument.endsWith("Check-Markdown.mjs"))) {
        const requestPath = args.at(-1);
        if (response.exitCode === 0) {
          const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
          response.stdout = JSON.stringify(
            request.Files.map((file) => ({
              File: file.File,
              Status: "PASS",
              Error: "",
              DurationMs: 0.1,
            })),
          );
        }
      }
      if (tool === "lychee") {
        const outputIndex = args.indexOf("--output");
        const outputPath = args[outputIndex + 1];
        const report = { error_map: {} };
        const online = !args.includes("--offline");
        if (
          ["review403", "review429", "reviewTimeout", "reviewAndQuality", "broken404", "localBroken"].includes(
            scenario,
          ) &&
          (online || scenario === "localBroken")
        ) {
          const code =
            scenario === "review403" || scenario === "reviewAndQuality"
              ? 403
              : scenario === "review429"
                ? 429
                : scenario === "broken404"
                  ? 404
                  : null;
          const url =
            scenario === "localBroken"
              ? "file:///missing.md"
              : "https://example.invalid/resource";
          const mapName = scenario === "reviewTimeout" ? "timeout_map" : "error_map";
          report[mapName] = {
            "docs/通用写作规范.md": [
              { url, status: { code, text: "simulated response" } },
            ],
          };
          response.exitCode = 2;
        }
        await fs.writeFile(
          outputPath,
          scenario === "badJson" ? "{bad json" : JSON.stringify(report),
          "utf8",
        );
      }
      return response;
    },
  };
  return {
    calls,
    runtimeOptions,
    reviewFactory: async () => ({ Status: "NOT_GENERATED_FOR_MOCKS" }),
  };
}

const inventoryRuntime = createRuntime();
const inventory = await discoverAuditScope({
  scopePath: path.join(repoRoot, "docs"),
  reportRoot: testReportPath("inventory"),
  runtime: inventoryRuntime,
});
const expectedFiles = inventory.files.length;
assert(expectedFiles > 0, "Tests require Markdown documents in docs.");

const cases = [
  { Mode: "pass", Gate: "LocalGate", Code: 0, Status: "PASS", Count: 7 },
  { Mode: "pass", Gate: "RemoteGate", Code: 0, Status: "PASS", Count: 8 },
  { Mode: "quality", Gate: "LocalGate", Code: 1, Status: "FAIL", Count: 7 },
  { Mode: "runtime", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "timeout", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "precedence", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "missing", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "review403", Gate: "RemoteGate", Code: 3, Status: "REVIEW", Count: 8 },
  { Mode: "review429", Gate: "RemoteGate", Code: 3, Status: "REVIEW", Count: 8 },
  { Mode: "reviewTimeout", Gate: "RemoteGate", Code: 3, Status: "REVIEW", Count: 8 },
  { Mode: "reviewAndQuality", Gate: "RemoteGate", Code: 1, Status: "FAIL", Count: 8 },
  { Mode: "broken404", Gate: "RemoteGate", Code: 1, Status: "FAIL", Count: 8 },
  { Mode: "localBroken", Gate: "LocalGate", Code: 1, Status: "FAIL", Count: 7 },
  { Mode: "badJson", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "valeFileError", Gate: "LocalGate", Code: 2, Status: "ERROR", Count: 7 },
  { Mode: "valeAlerts", Gate: "LocalGate", Code: 1, Status: "FAIL", Count: 7 },
];

for (const testCase of cases) {
  const harness = createHarness(testCase.Mode);
  const reportDirectory = testReportPath(`${testCase.Mode}-${testCase.Gate}`);
  const code = await invokeDocsAudit(
    {
      gate: testCase.Gate,
      path: "docs",
      reportDirectory,
    },
    harness,
  );
  const report = await latestSummary(path.join(reportDirectory, testCase.Gate));
  if (Object.hasOwn(report.summary, "Profile")) throw new Error("Profiler output appeared without -Profiler.");
  if (
    code !== testCase.Code ||
    report.summary.Status !== testCase.Status ||
    report.summary.Results.length !== testCase.Count ||
    report.summary.Files.length !== expectedFiles
  ) {
    throw new Error(
      `FAILED ${testCase.Mode}/${testCase.Gate}: code=${code} status=${report.summary.Status} checks=${report.summary.Results.length} files=${report.summary.Files.length}`,
    );
  }
  if (testCase.Mode === "pass") {
    for (const name of ["cspell", "prettier"]) {
      const calls = harness.calls.filter((call) => call.Tool === name);
      assertEqual(calls.length, 1, `${name} should check this scope in one batch`);
      if (name === "cspell") {
        const listIndex = calls[0].Arguments.indexOf("--file-list");
        assert(listIndex >= 0, "CSpell must use a file-list input.");
        const files = (await fs.readFile(calls[0].Arguments[listIndex + 1], "utf8"))
          .trim()
          .split(/\r?\n/);
        assertEqual(files.length, expectedFiles, "CSpell input manifest omitted files.");
      } else {
        assert(
          calls[0].Arguments.some((argument) => argument.endsWith("Check-Markdown.mjs")),
          "Prettier must use the local API helper.",
        );
        const request = JSON.parse(await fs.readFile(calls[0].Arguments.at(-1), "utf8"));
        assertEqual(request.Files.length, expectedFiles, "Prettier input manifest omitted files.");
      }
      assertEqual(
        calls[0].TimeoutSeconds,
        180 * expectedFiles,
        `${name} batch timeout does not preserve the input budget`,
      );
    }
    for (const call of harness.calls.filter((entry) => entry.Tool === "lychee")) {
      const listIndex = call.Arguments.indexOf("--files-from");
      const files = (await fs.readFile(call.Arguments[listIndex + 1], "utf8"))
        .trim()
        .split(/\r?\n/);
      assertEqual(files.length, expectedFiles, "lychee file-list omitted scope files.");
    }
  }
  if (testCase.Mode.startsWith("vale")) {
    const valeCalls = harness.calls.filter((call) => call.Tool === "vale");
    assertEqual(valeCalls.length, expectedFiles, "Vale stopped before checking every file");
    const vale = report.summary.Results.find((result) => result.Tool === "vale");
    assertEqual(
      (vale.FileErrors ?? []).length,
      testCase.Mode === "valeFileError" ? 1 : 0,
      "Vale file errors were not collected",
    );
    assertEqual((vale.Findings ?? []).length, 1, "Vale findings were not collected");
    assert(report.diagnosis.includes("simulated term alert"), "Vale finding is missing from diagnosis.");
    if (testCase.Mode === "valeFileError") {
      assert(
        report.diagnosis.includes("yaml: simulated frontmatter error"),
        "Vale file error is missing from diagnosis.",
      );
    }
  }
  console.log(`TEST PASS: ${testCase.Mode}/${testCase.Gate}`);
}

const names = Array.from({ length: 260 }, (_, index) => `中文 path/${index} document.md`);
const groups = getAuditFileBatches(names, repoRoot);
assertEqual(groups.flatMap((group) => group.Files).join("|"), names.join("|"), "Batch splitting changed order");
assert(
  groups.every((group) => group.Files.length <= 128),
  "Batch splitting exceeded the file limit.",
);
const smallGroups = getAuditFileBatches(names, repoRoot, { maxCharacters: 1600 });
assert(smallGroups.length > groups.length, "Command-line character budget was ignored.");

for (const mode of ["pass", "runtime", "timeout", "missing", "launchError"]) {
  const harness = createHarness(mode);
  const reportDirectory = testReportPath(`profile-${mode}`);
  const code = await invokeDocsAudit(
    {
      gate: "LocalGate",
      path: "docs",
      reportDirectory,
      profiler: true,
    },
    harness,
  );
  const report = await latestSummary(path.join(reportDirectory, "LocalGate"));
  assert(report.summary.Profile?.Enabled, "Missing profiler timing data.");
  assert(report.summary.Profile.DurationMs > 0, "Profiler total duration must be positive.");
  assert(report.summary.Profile.Calls.length > 0, "Profiler recorded no calls.");
  assert(
    report.summary.Results.every(
      (result) => typeof result.DurationMs === "number" && result.DurationMs >= 0,
    ),
    "Missing tool duration.",
  );
  assert(
    report.summary.Profile.Calls.some((call) => call.Phase === "check"),
    "Missing per-file call timings.",
  );
  if (mode === "timeout") {
    assert(
      report.summary.Profile.Calls.some((call) => call.TimedOut),
      "Timeout timing was lost.",
    );
  }
  if (mode === "launchError") {
    assert(
      report.summary.Profile.Calls.some(
        (call) => call.Error === "Simulated process start failure",
      ),
      "Process start failure timing was lost.",
    );
  }
  assert(report.diagnosis.includes("## 耗时统计"), "Missing timing summary.");
  assert(report.diagnosis.includes("-Profiler"), "Missing profiler rerun flag.");
  assert(report.diagnosis.includes("其他编排耗时"), "Timing report does not reconcile durations.");
  assertEqual(code, mode === "pass" ? 0 : 2, "Profiler changed Gate exit status");
}

const resetHarness = createHarness("pass");
const resetReportDirectory = testReportPath("profile-reset");
await invokeDocsAudit(
  { gate: "LocalGate", path: "docs", reportDirectory: resetReportDirectory },
  resetHarness,
);
const resetReport = await latestSummary(path.join(resetReportDirectory, "LocalGate"));
assert(!Object.hasOwn(resetReport.summary, "Profile"), "Profiler state leaked into a later run.");

const emptyReportDirectory = testReportPath("empty");
const emptyCode = await invokeDocsAudit({
  gate: "LocalGate",
  path: "docs/does-not-exist",
  reportDirectory: emptyReportDirectory,
});
assertEqual(emptyCode, 2, "Empty scope did not return ERROR");

console.log(
  `All ${cases.length} contract scenarios passed. CLI responses were simulated; this is not real six-tool acceptance.`,
);
