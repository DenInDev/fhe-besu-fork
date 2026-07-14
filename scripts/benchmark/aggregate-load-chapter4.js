#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const chapterRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("runtime");
const repoRoot = path.resolve(__dirname, "..", "..");
const chainRoot = path.resolve(repoRoot, "..", "..");
const contractDeployment = path.join(chainRoot, "contract-deployment");

const sources = [
  {
    id: "besu-only",
    label: "Besu-only",
    dir: path.join(contractDeployment, "logs", "python-rpc-besu-only-threads-eq-rate-20260610-155715"),
    rates: [1, 5, 10, 20, 40, 60, 80, 100],
  },
  {
    id: "zama-fhevm",
    label: "Zama fhEVM locale",
    dir: path.join(contractDeployment, "logs", "python-rpc-fhe-threads-eq-rate-20260610-163600"),
    rates: [1, 5, 10, 20, 40, 60],
  },
  {
    id: "besufhe",
    label: "BesuFHE",
    dir: path.join(chapterRoot, "besufhe-load-notarize"),
    rates: [1, 5, 10, 20, 40, 60, 80, 100],
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function maybeReadJson(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (Number.isInteger(value)) return Number(value).toLocaleString("it-IT");
  return Number(value).toLocaleString("it-IT", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Math.round(Number(value)).toLocaleString("it-IT");
}

function latexEscape(value) {
  return String(value).replace(/_/g, "\\_");
}

function rowFromReport(source, rate, report) {
  const error = report?.summary?.status === "ERROR";
  if (error) {
    return {
      protocol: source.label,
      rate,
      status: "ERROR",
      scheduledTx: report.profile?.scheduledTx ?? null,
      minedTx: null,
      failedTx: null,
      throughput: null,
      blocksToClose: null,
      activeBlocks: null,
      txPerBlockMean: null,
      blockIntervalMean: null,
      gasMean: null,
      latencyMean: null,
      note: report.summary?.error ?? "errore",
    };
  }

  return {
    protocol: source.label,
    rate,
    status: "PASS",
    scheduledTx: report.profile?.scheduledTx ?? null,
    minedTx: report.summary?.minedTx ?? null,
    failedTx: report.summary?.failedTx ?? null,
    throughput: report.summary?.closureThroughputTxPerSec ?? null,
    blocksToClose: report.summary?.blocksRequiredToClose ?? null,
    activeBlocks: report.summary?.activeBenchmarkBlocks ?? null,
    txPerBlockMean: report.stats?.txPerActiveBlock?.mean ?? null,
    blockIntervalMean: report.stats?.activeBlockIntervalSec?.mean ?? null,
    gasMean: report.stats?.gasUsed?.mean ?? null,
    latencyMean: report.stats?.endToEndLatencyMs?.mean ?? null,
    note: "",
  };
}

const rows = [];
for (const source of sources) {
  for (const rate of source.rates) {
    const report = maybeReadJson(path.join(source.dir, `${rate}tps.json`)) || maybeReadJson(path.join(source.dir, `${rate}tps-error.json`));
    if (!report) continue;
    rows.push(rowFromReport(source, rate, report));
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  chapterRoot,
  sources: sources.map((source) => ({ id: source.id, label: source.label, dir: source.dir })),
  rows,
};

const md = [];
md.push("# Benchmark carico Capitolo 4");
md.push("");
md.push("Durata dei profili: 30 s. Le metriche sui blocchi usano i timestamp dei blocchi attivi del benchmark.");
md.push("");
md.push("| Protocollo | Rate (tx/s) | Stato | Tx sched. | Tx minate | Tx fallite | Throughput reale (tx/s) | Blocchi chiusura | Blocchi attivi | Tx/blocco medio | Intervallo blocchi medio (s) | Gas medio | Latenza media (ms) |");
md.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  md.push(
    `| ${row.protocol} | ${row.rate} | ${row.status} | ${fmtInt(row.scheduledTx)} | ${fmtInt(row.minedTx)} | ${fmtInt(row.failedTx)} | ${fmt(row.throughput, 3)} | ${fmtInt(row.blocksToClose)} | ${fmtInt(row.activeBlocks)} | ${fmt(row.txPerBlockMean, 1)} | ${fmt(row.blockIntervalMean, 2)} | ${fmt(row.gasMean, 1)} | ${fmt(row.latencyMean, 1)} |`
  );
}
md.push("");
md.push("Note:");
md.push("- Besu-only e Zama fhEVM derivano dai benchmark Python RPC gia' prodotti con invio raw transaction.");
md.push("- BesuFHE misura `addEnergyEntry` con ciphertext on-chain, digest binding e input proof Groth16.");
md.push("- Nei profili BesuFHE ad alto rate il throughput reale va letto insieme a `Blocchi chiusura`, `Tx/blocco medio` e `Intervallo blocchi medio`: sopra 60 tx/s il carico viene accettato, ma la chiusura del workload rallenta sensibilmente.");

const tex = [];
tex.push("% Tabella carico Capitolo 4");
tex.push("\\begin{table}[H]");
tex.push("\\centering");
tex.push("\\caption{Benchmark di carico su rete Besu locale}");
tex.push("\\label{tab:chapter4-load-benchmark}");
tex.push("\\begin{tabular}{lrrrrrrrr}");
tex.push("\\hline");
tex.push("\\textbf{Protocollo} & \\textbf{Rate} & \\textbf{Tx minate} & \\textbf{Fail} & \\textbf{Thr. reale} & \\textbf{Blocchi} & \\textbf{Tx/blocco} & \\textbf{Gas medio} & \\textbf{Lat. media} \\\\");
tex.push("\\hline");
for (const row of rows) {
  tex.push(
    `${latexEscape(row.protocol)} & ${row.rate} & ${fmtInt(row.minedTx)} & ${fmtInt(row.failedTx)} & ${fmt(row.throughput, 2)} & ${fmtInt(row.blocksToClose)} & ${fmt(row.txPerBlockMean, 1)} & ${fmt(row.gasMean, 0)} & ${fmt(row.latencyMean, 0)} \\\\`
  );
}
tex.push("\\hline");
tex.push("\\end{tabular}");
tex.push("\\end{table}");

fs.writeFileSync(path.join(chapterRoot, "chapter4-load-summary.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(chapterRoot, "chapter4-load-summary.md"), md.join("\n"));
fs.writeFileSync(path.join(chapterRoot, "chapter4-load-summary.tex"), tex.join("\n"));

console.log(`Wrote ${path.join(chapterRoot, "chapter4-load-summary.md")}`);
console.log(`Wrote ${path.join(chapterRoot, "chapter4-load-summary.tex")}`);
console.log(`Wrote ${path.join(chapterRoot, "chapter4-load-summary.json")}`);
