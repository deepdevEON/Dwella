const isWin = process.platform === "win32";
const platform = isWin ? "win32" : process.platform;
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const PROFILES_PATH = () => path.join(platform === "win32"
  ? path.join(require("node:os").homedir(), ".dwella-desktop")
  : require("node:os").homedir() + "/Library/Application Support/dwella-desktop", "mt5-profiles.json");

function getSafeStorage() {
  try { return require("electron").safeStorage; } catch { return null; }
}

async function readProfiles() {
  try { return JSON.parse(await fs.readFile(PROFILES_PATH(), "utf8")); } catch { return { profiles: [] }; }
}
async function writeProfiles(data) {
  await fs.mkdir(path.dirname(PROFILES_PATH()), { recursive: true });
  await fs.writeFile(PROFILES_PATH(), JSON.stringify(data, null, 2), { mode: 0o600 });
}
function encryptField(text) {
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return Buffer.from(text, "utf8").toString("base64");
  return ss.encryptString(text).toString("base64");
}
function decryptField(b64) {
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return Buffer.from(b64, "base64").toString("utf8");
  try { return ss.decryptString(Buffer.from(b64, "base64")); } catch { return ""; }
}

async function getMt5Profiles() {
  const data = await readProfiles();
  return data.profiles.map(p => ({ ...p, password: decryptField(p.password) }));
}

async function saveMt5Profile(profile) {
  const data = await readProfiles();
  const encrypted = { ...profile, password: encryptField(profile.password || "") };
  const idx = data.profiles.findIndex(p => p.name === profile.name);
  if (idx >= 0) data.profiles[idx] = encrypted; else data.profiles.push(encrypted);
  await writeProfiles(data);
}

async function deleteMt5Profile(name) {
  const data = await readProfiles();
  data.profiles = data.profiles.filter(p => p.name !== name);
  await writeProfiles(data);
}

async function getDefaultProfile() {
  const profiles = await getMt5Profiles();
  return profiles.find(p => p.isDefault) || profiles[0] || null;
}

async function getPlatform() {
  return platform;
}

async function ensureMt5Installed(log = () => {}) {
  if (isWin) {
    const win = require("./mt5-windows.cjs");
    return win.ensureMt5Installed(log);
  }
  const mac = require("./mt5-mac.cjs");
  return mac.ensureMt5Installed(log);
}

async function launchEngineHidden() {
  if (isWin) {
    const win = require("./mt5-windows.cjs");
    return win.launchEngineHidden();
  }
  const mac = require("./mt5-mac.cjs");
  return mac.launchEngineHidden();
}

async function provision(log = () => {}) {
  if (isWin) {
    const win = require("./mt5-windows.cjs");
    return win.provision(log);
  }
  const mac = require("./mt5-mac.cjs");
  return mac.provision(log);
}

async function startBridge() {
  if (isWin) {
    const win = require("./mt5-windows.cjs");
    return win.startBridge();
  }
  const mac = require("./mt5-mac.cjs");
  return mac.startBridge();
}

const { exists } = require("node:fs/promises");

async function selfHeal(log = () => {}) {
  if (isWin) {
    const installPath = await require("./mt5-windows.cjs").findMt5Installation();
    if (!installPath) {
      log("MT5 uninstalled on Windows — re-installing\u2026");
      return ensureMt5Installed(log);
    }
    return true;
  }
  if (!(await exists("/Applications/MetaTrader 5.app"))) {
    log("MT5.app missing on macOS — re-downloading\u2026");
    return ensureMt5Installed(log);
  }
  return true;
}

module.exports = { getPlatform, ensureMt5Installed, launchEngineHidden, provision, startBridge, selfHeal, getMt5Profiles, saveMt5Profile, deleteMt5Profile, getDefaultProfile };
