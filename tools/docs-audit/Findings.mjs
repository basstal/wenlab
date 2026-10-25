import { stripAnsi } from "./AuditRuntime.mjs";

export function getAutoCorrectFindings(text) {
  const clean = stripAnsi(text);
  const findings = [];
  if (clean.trimStart().startsWith("{")) {
    const report = JSON.parse(clean);
    if (!Object.hasOwn(report, "messages")) {
      throw new Error("Unsupported AutoCorrect JSON: missing messages.");
    }
    for (const message of report.messages) {
      if (message.error) throw new Error(`AutoCorrect execution error: ${message.error}`);
      for (const line of message.lines ?? []) {
        findings.push({
          File: String(message.filepath).replaceAll("\\", "/"),
          Line: line.l,
          Column: line.c,
          Old: line.old,
          New: line.new,
          Severity: line.severity,
        });
      }
    }
    return findings;
  }
  const pattern =
    /^(?<file>[^\r\n]+):(?<line>\d+):(?<column>\d+)\r?\n-(?<old>[^\r\n]*)\r?\n\+(?<new>[^\r\n]*)/gm;
  for (const match of clean.matchAll(pattern)) {
    findings.push({
      File: match.groups.file.replaceAll("\\", "/"),
      Line: Number(match.groups.line),
      Column: Number(match.groups.column),
      Old: match.groups.old,
      New: match.groups.new,
      Severity: 1,
    });
  }
  return findings;
}

export function getCSpellFindings(text) {
  const findings = [];
  const pattern =
    /^(?<file>[^\r\n]+):(?<line>\d+):(?<column>\d+) - Unknown word \((?<word>[^\r\n]+)\)\r?$/gm;
  for (const match of stripAnsi(text).matchAll(pattern)) {
    findings.push({
      File: match.groups.file.replaceAll("\\", "/"),
      Line: Number(match.groups.line),
      Column: Number(match.groups.column),
      Word: match.groups.word,
    });
  }
  return findings;
}
