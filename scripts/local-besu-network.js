#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");

const ACTIONS = {
  configure: "besu/scripts/configure-network-genesis.sh",
  "build-native": "native/scripts/build.sh",
  build: "besu/scripts/build-fork.sh",
  start: "besu/scripts/start-besu-network.sh",
  stop: "besu/scripts/stop-besu-network.sh",
  reset: "besu/network/start-nodes.sh",
  "smoke-precompile": "native/scripts/smoke_precompile_add.sh",
  status: "besu/network/start-nodes.sh",
};

const action = process.argv[2];
if (!action || !ACTIONS[action]) {
  console.error(`Usage: node scripts/local-besu-network.js ${Object.keys(ACTIONS).join("|")}`);
  process.exit(1);
}

const cwd = process.cwd();
const script = ACTIONS[action];
const scriptArgs = action === "reset" || action === "status" ? [action] : process.argv.slice(3);

function toWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    throw new Error(`Cannot convert Windows path to WSL path: ${winPath}`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

let result;
if (process.platform === "win32") {
  const wslCwd = toWslPath(cwd);
  const command = [
    `cd ${shQuote(wslCwd)}`,
    "&&",
    "bash",
    shQuote(script),
    ...scriptArgs.map(shQuote),
  ].join(" ");
  result = spawnSync("wsl.exe", ["bash", "-lc", command], { stdio: "inherit" });
} else {
  result = spawnSync("bash", [path.join(cwd, script), ...scriptArgs], {
    cwd,
    stdio: "inherit",
  });
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
