import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TfheToolOptions = {
  allowUnsafePbs?: boolean;
  env?: Record<string, string>;
};

export function projectRoot() {
  return path.resolve(__dirname, "..", "..");
}

export function projectPath(...parts: string[]) {
  return path.resolve(projectRoot(), ...parts);
}

export function envInt(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

export function quoteBash(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toWslPath(filePath: string) {
  const absolute = path.resolve(filePath);
  if (process.platform !== "win32") return absolute;
  return execFileSync("wsl.exe", ["wslpath", "-a", absolute.replace(/\\/g, "/")], {
    encoding: "utf8"
  }).trim();
}

export function nativeDir() {
  return projectPath("native");
}

export function tfheToolPath() {
  return process.env.FHEBC_TFHE_TOOL
    ? path.resolve(process.env.FHEBC_TFHE_TOOL)
    : projectPath("runtime", "native", "tfhe_tool");
}

export function runTfheTool(args: string[], options: TfheToolOptions = {}) {
  const cwd = nativeDir();
  if (process.platform === "win32") {
    const command = [
      "cd",
      quoteBash(toWslPath(cwd)),
      "&&",
      options.allowUnsafePbs ? "FHEBC_ALLOW_NONDETERMINISTIC_PBS=1" : "",
      ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${quoteBash(value.match(/^[A-Za-z]:[\\/]/) ? toWslPath(value) : value)}`),
      quoteBash(toWslPath(tfheToolPath())),
      ...args.map((arg) => quoteBash(arg.match(/^[A-Za-z]:[\\/]/) ? toWslPath(arg) : arg))
    ]
      .filter(Boolean)
      .join(" ");
    return execFileSync("wsl.exe", ["--", "/bin/bash", "-lc", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  }

  return execFileSync(tfheToolPath(), args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.allowUnsafePbs ? { FHEBC_ALLOW_NONDETERMINISTIC_PBS: "1" } : {}),
      ...(options.env ?? {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export async function runTfheToolAsync(args: string[], options: TfheToolOptions = {}) {
  const cwd = nativeDir();
  if (process.platform === "win32") {
    const command = [
      "cd",
      quoteBash(toWslPath(cwd)),
      "&&",
      options.allowUnsafePbs ? "FHEBC_ALLOW_NONDETERMINISTIC_PBS=1" : "",
      ...Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${quoteBash(value.match(/^[A-Za-z]:[\\/]/) ? toWslPath(value) : value)}`),
      quoteBash(toWslPath(tfheToolPath())),
      ...args.map((arg) => quoteBash(arg.match(/^[A-Za-z]:[\\/]/) ? toWslPath(arg) : arg))
    ]
      .filter(Boolean)
      .join(" ");
    const { stdout } = await execFileAsync("wsl.exe", ["--", "/bin/bash", "-lc", command], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout.trim();
  }

  const { stdout } = await execFileAsync(tfheToolPath(), args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.allowUnsafePbs ? { FHEBC_ALLOW_NONDETERMINISTIC_PBS: "1" } : {}),
      ...(options.env ?? {})
    },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

export function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureKeys(clientKey: string, serverKey: string) {
  if (fs.existsSync(clientKey) && fs.existsSync(serverKey)) return;
  console.log("Generating TFHE-rs keys. This can take a while...");
  ensureParent(clientKey);
  runTfheTool(["keygen", clientKey, serverKey]);
}

export function encryptU32(clientKey: string, value: number, outFile: string) {
  ensureParent(outFile);
  const command = process.env.REAL_TFHE_CIPHERTEXT_FORMAT === "raw" ? "encrypt-u32" : "encrypt-u32-compressed";
  runTfheTool([command, clientKey, String(value), outFile]);
}

export function decryptU32(clientKey: string, ciphertextFile: string, serverKey?: string) {
  return Number(
    runTfheTool(["decrypt-u32", clientKey, ciphertextFile], {
      env: serverKey ? { FHEBC_TFHE_SERVER_KEY_PATH: serverKey } : undefined
    })
      .split(/\r?\n/)
      .pop()
  );
}

export function decryptBool(clientKey: string, ciphertextFile: string, serverKey?: string) {
  return (
    runTfheTool(["decrypt-bool", clientKey, ciphertextFile], {
      env: serverKey ? { FHEBC_TFHE_SERVER_KEY_PATH: serverKey } : undefined
    })
      .split(/\r?\n/)
      .pop() === "true"
  );
}

export function writeCiphertextHex(filePath: string, ciphertextHex: string) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, Buffer.from(ciphertextHex.replace(/^0x/, ""), "hex"));
}

export function readCiphertextHex(filePath: string) {
  return `0x${fs.readFileSync(filePath).toString("hex")}`;
}

export function dispatchAddU32(serverKey: string, leftFile: string, rightFile: string, outFile: string) {
  runTfheTool(["dispatch-add-u32", serverKey, leftFile, rightFile, outFile], {
    allowUnsafePbs: true,
    env: { FHEBC_NATIVE_COMPRESSED_OUTPUTS: "1", FHEBC_PACKED_OUTPUTS: "1" }
  });
}

export function dispatchMulScalarU32(serverKey: string, inputFile: string, scalar: bigint, outFile: string) {
  runTfheTool(["dispatch-mul-scalar-u32", serverKey, inputFile, scalar.toString(), outFile], {
    allowUnsafePbs: true,
    env: { FHEBC_NATIVE_COMPRESSED_OUTPUTS: "1", FHEBC_PACKED_OUTPUTS: "1" }
  });
}

export function dispatchMeanU32(serverKey: string, outFile: string, inputFiles: string[]) {
  if (inputFiles.length === 0) {
    throw new Error("dispatchMeanU32 requires at least one input ciphertext.");
  }
  runTfheTool(["dispatch-mean-u32", serverKey, outFile, ...inputFiles], {
    allowUnsafePbs: true,
    env: { FHEBC_NATIVE_COMPRESSED_OUTPUTS: "1", FHEBC_PACKED_OUTPUTS: "1" }
  });
}

export function dispatchMaxU32(serverKey: string, outFile: string, inputFiles: string[]) {
  if (inputFiles.length === 0) {
    throw new Error("dispatchMaxU32 requires at least one input ciphertext.");
  }
  runTfheTool(["dispatch-max-u32", serverKey, outFile, ...inputFiles], {
    allowUnsafePbs: true,
    env: { FHEBC_NATIVE_COMPRESSED_OUTPUTS: "1", FHEBC_PACKED_OUTPUTS: "1" }
  });
}
