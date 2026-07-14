const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
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

function winePath(p) {
  return "Z:" + p.replace(/\\/g, "/");
}

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

async function detectWine() {
  const candidates = ["wine", "wine64"];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function installSilently(log) {
  log("Downloading MetaTrader 5 installer\u2026");
  const installer = path.join(CACHE, "mt5-setup.exe");
  await download(MT5_SETUP_URL, installer);

  const wine = await detectWine();
  if (!wine) throw new Error("Wine is not installed. Install Wine to run MT5 on this platform.");

  log("Installing MetaTrader 5 via Wine (silent mode)\u2026");
  const env = {
    ...process.env,
    WINEPREFIX: path.join(os.homedir(), ".wine"),
    WINEDEBUG: "-all",
  };

  await execFileAsync(wine, [installer, "/S"], { env, timeout: 600000 });
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

  const wine = await detectWine();
  if (!wine) throw new Error("Wine is not installed");

  const env = {
    ...process.env,
    WINEPREFIX: path.join(os.homedir(), ".wine"),
    WINEDEBUG: "-all",
  };

  spawn(wine, [exe], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
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

async function startBridge() {
  await deployBridge(() => {});
  const wine = await detectWine();
  if (!wine) return false;

  const exe = path.join(BRIDGE_DIR, "python", "python.exe");
  const env = {
    ...process.env,
    WINEPREFIX: path.join(os.homedir(), ".wine"),
    WINEDEBUG: "-all",
  };

  const child = spawn(wine, [exe, path.join(BRIDGE_DIR, "dwella_bridge.py")], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
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
  return startBridge();
}

module.exports = { provision, startBridge, launchEngineHidden, ensureMt5Installed };
