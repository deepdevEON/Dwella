const isWin = process.platform === "win32";
const platform = isWin ? "win32" : process.platform;

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

module.exports = { getPlatform, ensureMt5Installed, launchEngineHidden, provision, startBridge, selfHeal };
