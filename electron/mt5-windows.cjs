const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const execFileAsync = promisify(execFile);

const MT5_INSTALL_PATHS = [
  path.join("C:", "Program Files", "MetaTrader 5"),
  path.join("C:", "Program Files (x86)", "MetaTrader 5"),
];

const MT5_SETUP_URL = "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/setup.exe";
const MT5_EXE = "terminal64.exe";
const CACHE = path.join(os.homedir(), ".dwella-desktop", "mt5-cache");
const BRIDGE_DIR = path.join(os.homedir(), ".dwella-desktop", "mt5-bridge");

const exists = (p) => fs.access(p).then(() => true, () => false);

async function download(url, dest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`download ${response.status}: ${url}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function findMt5Installation() {
  for (const installPath of MT5_INSTALL_PATHS) {
    if (await exists(installPath)) {
      const exe = path.join(installPath, MT5_EXE);
      if (await exists(exe)) return installPath;
    }
  }
  return null;
}

async function installSilently(log) {
  log("Downloading MetaTrader 5 installer\u2026");
  const installer = path.join(CACHE, "mt5-setup.exe");
  await download(MT5_SETUP_URL, installer);

  log("Installing MetaTrader 5 (native, silent)\u2026");
  try {
    await execFileAsync(installer, ["/S"], { windowsHide: true, timeout: 600000 });
  } catch (err) {
    if (!/exit code|status/i.test(String(err.message)) && err.code === "ENOENT") throw err;
    log("Silent install returned a non-zero exit code; continuing verification\u2026");
  }
}

async function ensureMt5Installed(log = () => {}) {
  const installPath = await findMt5Installation();
  if (!installPath) {
    await installSilently(log);
  }
  const verified = await findMt5Installation();
  if (!verified) throw new Error("MT5 installation verification failed");
  return verified;
}

async function launchEngineHidden() {
  const installPath = await findMt5Installation();
  if (!installPath) throw new Error("MT5 is not installed");

  const exe = path.join(installPath, MT5_EXE);
  if (!await exists(exe)) throw new Error(`MT5 executable not found: ${exe}`);

  spawn(exe, [], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function findPython() {
  for (const candidate of ["python", "python3", "py"]) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function deployBridge(log) {
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  const src = path.join(__dirname, "dwella_bridge.py");
  const dest = path.join(BRIDGE_DIR, "dwella_bridge.py");
  const content = await fs.readFile(src, "utf8");
  if ((await fs.readFile(dest, "utf8").catch(() => "")) !== content) {
    await fs.writeFile(dest, content);
    log("Bridge deployed.");
  }
}

async function startBridge(log = () => {}) {
  await deployBridge(log);
  const python = await findPython();
  if (!python) {
    log("Python not found; bridge not started. Install Python to enable live data.");
    return false;
  }

  const child = spawn(python, [path.join(BRIDGE_DIR, "dwella_bridge.py")], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch("http://127.0.0.1:8643/health", { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
  }
  return true;
}

async function provision(log = () => {}) {
  await ensureMt5Installed(log);
  await launchEngineHidden();
  return startBridge(log);
}

module.exports = { provision, startBridge, launchEngineHidden, ensureMt5Installed, findMt5Installation };
