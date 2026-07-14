// Dwella MT5 auto-provisioner: makes the MT5 engine "built in".
// On a fresh Mac this installs everything automatically: the MT5 terminal
// (official MetaQuotes download), a Windows Python runtime inside its Wine
// prefix, and the Dwella bridge. No manual steps, no visible MT5 UI.
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const execFileAsync = promisify(execFile);

const MT5_APP = "/Applications/MetaTrader 5.app";
const WINE = path.join(MT5_APP, "Contents/SharedSupport/wine/bin/wine");
const WINE_LIB = path.join(MT5_APP, "Contents/SharedSupport/wine/lib/external");
const PREFIX = path.join(os.homedir(), "Library/Application Support/net.metaquotes.wine.metatrader5");
const DRIVE_C = path.join(PREFIX, "drive_c");
const CACHE = path.join(os.homedir(), "Library/Application Support/dwella-desktop/mt5-cache");
const MT5_DMG_URL = "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/MetaTrader5.dmg";
const PY_EMBED_URL = "https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip";
const GET_PIP_URLS = ["https://bootstrap.pypa.io/pip/3.9/get-pip.py", "https://bootstrap.pypa.io/get-pip.py"];
const PYTHON_DIRS = ["Python39", "DwellaPython"];

const exists = (p) => fs.access(p).then(() => true, () => false);
const wineEnv = () => ({ ...process.env, WINEPREFIX: PREFIX, WINEDEBUG: "-all", DYLD_FALLBACK_LIBRARY_PATH: WINE_LIB });

async function download(url, dest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`download ${response.status}: ${url}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function winePythonPath() {
  for (const dir of PYTHON_DIRS) {
    if (await exists(path.join(DRIVE_C, dir, "python.exe"))) return `C:\\${dir}\\python.exe`;
  }
  return null;
}

async function ensureMt5App(log) {
  if (await exists(MT5_APP)) return;
  log("Downloading MetaTrader 5 engine from MetaQuotes…");
  const dmg = path.join(CACHE, "MetaTrader5.dmg");
  await download(MT5_DMG_URL, dmg);
  const { stdout } = await execFileAsync("hdiutil", ["attach", "-nobrowse", "-readonly", dmg]);
  const volume = stdout.split("\n").map((l) => l.split("\t").pop()?.trim()).find((p) => p && p.startsWith("/Volumes/"));
  if (!volume) throw new Error("could not mount MT5 dmg");
  try {
    const appName = (await fs.readdir(volume)).find((n) => n.endsWith(".app"));
    if (!appName) throw new Error("no .app inside MT5 dmg");
    log("Installing MT5 engine…");
    await execFileAsync("cp", ["-R", path.join(volume, appName), "/Applications/"]);
  } finally {
    await execFileAsync("hdiutil", ["detach", volume, "-force"]).catch(() => {});
  }
}

async function launchEngineHidden() {
  await execFileAsync("open", ["-gja", "MetaTrader 5"]).catch(() => {});
}

async function ensurePrefix(log) {
  if (await exists(DRIVE_C)) return;
  log("First run: MT5 engine is creating its environment…");
  await launchEngineHidden();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await exists(DRIVE_C)) return;
  }
  throw new Error("MT5 environment never appeared");
}

async function ensurePython(log) {
  if (await winePythonPath()) return;
  log("Installing market-data runtime…");
  const zip = path.join(CACHE, "python-embed.zip");
  await download(PY_EMBED_URL, zip);
  const target = path.join(DRIVE_C, "DwellaPython");
  await fs.mkdir(target, { recursive: true });
  await execFileAsync("unzip", ["-oq", zip, "-d", target]);
  const pth = path.join(target, "python39._pth");
  await fs.writeFile(pth, (await fs.readFile(pth, "utf8")).replace("#import site", "import site"));
  let pipOk = false;
  for (const url of GET_PIP_URLS) {
    try { await download(url, path.join(target, "get-pip.py")); pipOk = true; break; } catch {}
  }
  if (!pipOk) throw new Error("could not fetch get-pip.py");
  const run = (args) => execFileAsync(WINE, ["C:\\DwellaPython\\python.exe", ...args], { env: wineEnv(), timeout: 900000 });
  await run(["C:\\DwellaPython\\get-pip.py", "--no-warn-script-location", "-q"]);
  log("Installing MetaTrader5 API package…");
  await run(["-m", "pip", "install", "-q", "--no-warn-script-location", "MetaTrader5"]);
}

async function deployBridge(log) {
  const content = await fs.readFile(path.join(__dirname, "dwella_bridge.py"), "utf8");
  const dest = path.join(DRIVE_C, "dwella_bridge.py");
  if ((await fs.readFile(dest, "utf8").catch(() => "")) !== content) {
    await fs.writeFile(dest, content);
    log("Bridge updated.");
  }
}

async function startBridge() {
  const py = await winePythonPath();
  if (!py) return false;
  const child = spawn(WINE, [py, "C:\\dwella_bridge.py"], { env: wineEnv(), detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

async function provision(log = () => {}) {
  await ensureMt5App(log);
  await ensurePrefix(log);
  await launchEngineHidden();
  await ensurePython(log);
  await deployBridge(log);
  return startBridge();
}

module.exports = { provision, startBridge, launchEngineHidden };
