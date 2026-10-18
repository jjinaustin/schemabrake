import type { FileReport } from "./analyze.js";
import { RULES, type Severity } from "./rules.js";

const LABEL: Record<Severity, string> = { critical: "CRITICAL", warning: "WARNING", info: "INFO" };
const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟡", info: "🔵" };

export function summarize(reports: FileReport[]) {
  const count = (s: Severity) => reports.reduce((n, r) => n + r.findings.filter((f) => f.severity === s).length, 0);
  return {
    files: reports.length,
    critical: count("critical"),
    warning: count("warning"),
    info: count("info"),
    errors: reports.filter((r) => r.error).length,
  };
}

export function formatText(reports: FileReport[], color = false): string {
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const tint: Record<Severity, number> = { critical: 31, warning: 33, info: 36 };
  const lines: string[] = [];

  for (const r of reports) {
    if (!r.findings.length && !r.error) continue;
    lines.push(paint(1, r.path) + paint(2, `  (${r.orm})`));
    if (r.error) lines.push(`  ${paint(31, "PARSE ERROR")}${r.error.line ? ` line ${r.error.line}` : ""}  ${r.error.message}`);
    for (const f of r.findings) {
      lines.push(`  ${paint(tint[f.severity], LABEL[f.severity].padEnd(8))} ${f.rule}  line ${String(f.line).padEnd(4)} ${f.message}`);
      lines.push(paint(2, `  ${" ".repeat(8)} fix: ${f.advice}`));
    }
    lines.push("");
  }

  const s = summarize(reports);
  lines.push(
    `${s.files} migration file${s.files === 1 ? "" : "s"} checked: ` +
      `${s.critical} critical, ${s.warning} warning, ${s.info} info` +
      (s.errors ? `, ${s.errors} could not be parsed` : ""),
  );
  return lines.join("\n");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown for a pull-request comment. */
export function formatMarkdown(reports: FileReport[]): string {
  const s = summarize(reports);
  const out = [`## 🛡️ SchemaBrake safety report`, ""];
  out.push(`Checked ${s.files} migration file${s.files === 1 ? "" : "s"}: **${s.critical} critical**, ${s.warning} warning, ${s.info} info.`);

  for (const r of reports) {
    if (!r.findings.length && !r.error) continue;
    out.push("", `### \`${r.path}\``, "");
    if (r.error) {
      out.push(`⚠️ Could not parse${r.error.line ? ` (line ${r.error.line})` : ""}: ${cell(r.error.message)}`, "");
      continue;
    }
    out.push("| Status | Rule | Line | Hazard |", "| --- | --- | --- | --- |");
    for (const f of r.findings) {
      out.push(`| ${ICON[f.severity]} ${LABEL[f.severity]} | ${f.rule} ${RULES[f.rule].name} | ${f.line} | ${cell(f.message)} |`);
    }
    out.push("", "<details><summary>How to fix</summary>", "");
    for (const f of r.findings) out.push(`- **${f.rule}, line ${f.line}:** ${f.advice}`);
    out.push("", "</details>");
  }
  if (!s.critical && !s.warning && !s.info && !s.errors) out.push("", "No hazards found.");
  return out.join("\n");
}

export function formatJson(reports: FileReport[]): string {
  return JSON.stringify({ summary: summarize(reports), files: reports }, null, 2);
}
