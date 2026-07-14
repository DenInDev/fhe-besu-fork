#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("runtime");

const preferred = [
  {
    id: "besufhe-proof-backed-real",
    title: "BesuFHE proof-backed",
    report: path.join(root, "besufhe-proof-backed-real", "report.json"),
    note:
      "Input proof verifier mock; operation proof verifier Groth16 reale. Le operazioni tx add, mul_scalar, mean e max usano il flusso proof-backed.",
  },
  {
    id: "besufhe-real-input-proof-backed",
    title: "BesuFHE input proof reale",
    report: path.join(root, "besufhe-real-input-proof-backed", "report.json"),
    note:
      "Input proof Groth16 reale; add, mul_scalar, mean e max usano il flusso proof-backed con verifier Groth16 reale.",
  },
  {
    id: "zama-fhevm-local",
    title: "Zama fhEVM locale",
    report: findNewest(path.join(root, "zama-fhevm-local"), "report.json"),
    note:
      "Rete Besu locale con stack fhEVM Zama; warmup escluso dalle statistiche; decrypt classica aggregata.",
  },
];

const operationOrder = ["notarize", "decrypt", "add_view", "add", "mul_scalar", "mean_view", "mean", "max_view", "max"];

function findNewest(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  const matches = [];
  walk(dir, (file) => {
    if (path.basename(file) === filename) matches.push(file);
  });
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0] || null;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sampleFromReport(report) {
  if (Array.isArray(report.samples)) {
    return report.samples
      .filter((sample) => sample && !sample.error)
      .map((sample) => ({
        operation: String(sample.operation),
        kind: String(sample.kind || ""),
        gasUsed: Number(sample.gasUsed || 0),
        latencyMs: Number(sample.latencyMs || 0),
      }));
  }

  if (Array.isArray(report.records)) {
    return report.records
      .filter((sample) => sample && !sample.error)
      .map((sample) => ({
        operation: String(sample.operation),
        kind: String(sample.kind || ""),
        gasUsed: Number(sample.gasUsed || 0),
        latencyMs: Number(sample.latencyMs || 0),
      }));
  }

  return [];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function summarize(samples) {
  const byOperation = new Map();
  for (const sample of samples) {
    if (!operationOrder.includes(sample.operation)) continue;
    if (!byOperation.has(sample.operation)) byOperation.set(sample.operation, []);
    byOperation.get(sample.operation).push(sample);
  }

  const rows = [];
  for (const operation of operationOrder) {
    const items = byOperation.get(operation) || [];
    if (items.length === 0) continue;
    const gasValues = items.map((item) => item.gasUsed);
    const latencyValues = items.map((item) => item.latencyMs);
    const latencyMean = mean(latencyValues);
    const latencyStd = sampleStd(latencyValues);
    rows.push({
      operation,
      n: items.length,
      gasMean: Math.round(mean(gasValues)),
      latencyMean: Math.round(latencyMean),
      latencyStdPct: latencyMean === 0 ? 0 : (latencyStd / latencyMean) * 100,
    });
  }
  return rows;
}

function formatInt(value) {
  return Math.round(value).toLocaleString("it-IT");
}

function formatPct(value) {
  return value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function latexEscape(text) {
  return String(text).replace(/_/g, "\\_");
}

const sections = [];
for (const target of preferred) {
  if (!target.report || !fs.existsSync(target.report)) {
    sections.push({ ...target, missing: true, rows: [] });
    continue;
  }
  const report = readJson(target.report);
  sections.push({
    ...target,
    missing: false,
    reportPath: target.report,
    rows: summarize(sampleFromReport(report)),
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  root,
  sections,
};

const md = [];
md.push("# Benchmark Capitolo 4");
md.push("");
md.push(`Root dati: \`${root}\``);
md.push("");
for (const section of sections) {
  md.push(`## ${section.title}`);
  md.push("");
  if (section.missing) {
    md.push(`Report non ancora disponibile: \`${section.report || "n/d"}\``);
    md.push("");
    continue;
  }
  md.push(`Report: \`${section.reportPath}\``);
  md.push("");
  md.push("| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |");
  md.push("|---|---:|---:|---:|---:|");
  for (const row of section.rows) {
    md.push(
      `| ${row.operation} | ${row.n} | ${formatInt(row.gasMean)} | ${formatInt(row.latencyMean)} | ${formatPct(row.latencyStdPct)} |`,
    );
  }
  md.push("");
  md.push(`Nota: ${section.note}`);
  md.push("");
}

const tex = [];
tex.push("% Tabelle generate automaticamente da scripts/benchmark/aggregate-chapter4.js");
for (const section of sections.filter((item) => !item.missing)) {
  tex.push("\\begin{table}[H]");
  tex.push("\\centering");
  tex.push(`\\caption{Benchmark ${latexEscape(section.title)}}`);
  tex.push(`\\label{tab:${section.id.replace(/_/g, "-")}-benchmark}`);
  tex.push("\\begin{tabular}{lrrrr}");
  tex.push("\\hline");
  tex.push("\\textbf{Operazione} & \\textbf{n} & \\textbf{Gas medio} & \\textbf{Latenza media (ms)} & \\textbf{Dev. std latenza (\\%)} \\\\");
  tex.push("\\hline");
  for (const row of section.rows) {
    tex.push(
      `${latexEscape(row.operation)} & ${row.n} & ${formatInt(row.gasMean)} & ${formatInt(row.latencyMean)} & ${formatPct(row.latencyStdPct)} \\\\`,
    );
  }
  tex.push("\\hline");
  tex.push("\\end{tabular}");
  tex.push("\\end{table}");
  tex.push("\\vspace{8pt}");
  tex.push("");
}

fs.writeFileSync(path.join(root, "chapter4-benchmark-summary.json"), JSON.stringify(output, null, 2));
fs.writeFileSync(path.join(root, "chapter4-benchmark-summary.md"), md.join("\n"));
fs.writeFileSync(path.join(root, "chapter4-benchmark-summary.tex"), tex.join("\n"));

console.log(`Wrote ${path.join(root, "chapter4-benchmark-summary.md")}`);
console.log(`Wrote ${path.join(root, "chapter4-benchmark-summary.tex")}`);
console.log(`Wrote ${path.join(root, "chapter4-benchmark-summary.json")}`);
