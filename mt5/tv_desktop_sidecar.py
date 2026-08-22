#!/usr/bin/env python3
"""External TradingView Desktop policy wrapper for Dwella.

The legacy sidecar contains historical embedded-app/setup code. This wrapper
keeps its market, scanner, and order logic while replacing the host checks and
control endpoints with a strict local prerequisite policy:

- TradingView Desktop must already be installed.
- The user starts it with CDP enabled and signs into Tradovate there.
- Dwella only observes that session and sends orders through the existing
  TradingView UI/risk-gated executor.
- No endpoint in this wrapper downloads, embeds, hides, or launches TV.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

import tv_sidecar as impl


CDP_HOST = os.environ.get("DWELLA_TV_CDP_HOST", "127.0.0.1")
try:
    CDP_PORT = int(os.environ.get("DWELLA_TV_CDP_PORT", "9222"))
except ValueError:
    CDP_PORT = 9222


def _path_exists(path: str | None) -> bool:
    if not path:
        return False
    return os.path.isdir(path) if path.endswith(".app") else os.path.isfile(path)


def _candidates() -> list[str]:
    if sys.platform == "darwin":
        return [
            "/Applications/TradingView.app",
            "/Applications/Trading and Finance/TradingView.app",
            os.path.expanduser("~/Applications/TradingView.app"),
        ]
    if sys.platform == "win32":
        return [
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\TradingView\TradingView.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\TradingView\TradingView.exe"),
            os.path.expandvars(r"%PROGRAMFILES%\TradingView\TradingView.exe"),
        ]
    return [
        "/opt/TradingView/TradingView",
        os.path.expanduser("~/.local/share/TradingView/TradingView"),
    ]


def tv_app_path() -> str:
    return next((path for path in _candidates() if _path_exists(path)), "")


def cdp_reachable(timeout: float = 2.0) -> bool:
    import socket
    try:
        sock = socket.create_connection((CDP_HOST, CDP_PORT), timeout=timeout)
        sock.close()
        return True
    except Exception:
        return False


def cdp_targets(timeout: float = 3.0) -> list[dict]:
    try:
        url = f"http://{CDP_HOST}:{CDP_PORT}/json/list"
        with urllib.request.urlopen(url, timeout=timeout) as response:
            targets = json.loads(response.read().decode("utf-8"))
        return [
            target for target in targets
            if target.get("type") in ("page", "webview")
            and (
                "tradingview.com" in str(target.get("url", "")).lower()
                or "tradingview" in str(target.get("title", "")).lower()
            )
        ]
    except Exception:
        return []


def tv_target_present() -> bool:
    return bool(cdp_targets())


def tv_process_running() -> bool:
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq TradingView.exe"],
                capture_output=True, text=True, timeout=3,
            )
            return "tradingview.exe" in result.stdout.lower()
        result = subprocess.run(
            ["pgrep", "-f", "TradingView"], capture_output=True,
            text=True, timeout=3,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def verify_session() -> dict:
    path = tv_app_path()
    if not path:
        return {
            "ok": False,
            "code": "tv_not_installed",
            "error": "TradingView Desktop is not installed on this device",
            "tv_installed": False,
            "tv_path": "",
        }
    if not cdp_reachable():
        return {
            "ok": False,
            "code": "tv_not_running",
            "error": "TradingView Desktop is installed but its CDP session is not reachable",
            "tv_installed": True,
            "tv_path": path,
            "cdp_port": CDP_PORT,
        }
    if not tv_target_present():
        return {
            "ok": False,
            "code": "tv_target_missing",
            "error": "TradingView Desktop is running without a TradingView CDP page",
            "tv_installed": True,
            "tv_path": path,
            "cdp_port": CDP_PORT,
        }
    return {
        "ok": True,
        "code": "connected",
        "message": "Connected to the already-running TradingView Desktop session",
        "tv_installed": True,
        "tv_path": path,
        "cdp_port": CDP_PORT,
    }


def check_payload() -> dict:
    session = verify_session()
    node_installed = os.path.isfile(impl.NODE_BIN) and os.access(impl.NODE_BIN, os.X_OK)
    mcp_installed = os.path.isfile(impl.MCP_CLI)
    node_ok = False
    mcp_ok = False
    try:
        result = subprocess.run([impl.NODE_BIN, "--version"], capture_output=True, text=True, timeout=5)
        node_ok = result.returncode == 0
    except Exception:
        pass
    try:
        result = subprocess.run([impl.NODE_BIN, impl.MCP_CLI, "--help"], capture_output=True, text=True, timeout=10)
        mcp_ok = result.returncode == 0 or "TradingView" in (result.stdout + result.stderr)
    except Exception:
        pass
    return {
        "tv_installed": bool(session.get("tv_installed")),
        "tv_managed_installed": bool(session.get("tv_installed")),
        "tv_path": session.get("tv_path", ""),
        "tv_process_running": tv_process_running(),
        "tv_target_present": tv_target_present(),
        "tv_updates_blocked": False,
        "tv_updates_managed": False,
        "cdp_ok": cdp_reachable(),
        "cdp_port": CDP_PORT,
        "node_ok": node_ok,
        "node_installed": node_installed,
        "node_path": impl.NODE_BIN,
        "mcp_ok": mcp_ok,
        "mcp_installed": mcp_installed,
        "mcp_path": impl.MCP_CLI,
        "durable_ready": bool(session.get("tv_installed") and node_installed and mcp_installed),
        "connected": bool(session.get("ok")),
        "launch_disabled": True,
    }

def launch_tradingview(timeout: float = 30.0) -> dict:
    """Launch the already-installed TradingView Desktop app with CDP enabled.

    This opens the official app that the user installed; it never downloads,
    embeds, patches, or hides it. If CDP is already reachable the existing
    session is reused. Otherwise the app binary is started with the remote
    debugging flags and the session is polled until it appears.
    """
    path = tv_app_path()
    if not path:
        return {
            "ok": False,
            "code": "tv_not_installed",
            "error": "TradingView Desktop is not installed on this device, so Dwella cannot open it. Install the official app first (one time) and press this again — it will launch automatically after that.",
            "tv_installed": False,
            "tv_path": "",
            "launched": False,
        }
    if cdp_reachable():
        session = verify_session()
        session.update({"launched": False, "already_running": True})
        return session

    binary = path
    if sys.platform == "darwin" and path.endswith(".app"):
        binary = os.path.join(path, "Contents", "MacOS", "TradingView")
    try:
        if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
            return {
                "ok": False,
                "code": "tv_binary_missing",
                "error": f"TradingView was found at {path} but its executable is missing.",
                "tv_installed": True,
                "tv_path": path,
                "launched": False,
            }
        subprocess.Popen(
            [binary, "--remote-debugging-port=%d" % CDP_PORT, "--remote-allow-origins=*"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        return {
            "ok": False,
            "code": "tv_launch_error",
            "error": f"TradingView could not be opened automatically: {exc}",
            "tv_installed": True,
            "tv_path": path,
            "launched": False,
        }

    deadline = time.time() + timeout
    while time.time() < deadline:
        if cdp_reachable() and tv_target_present():
            session = verify_session()
            session.update({"launched": True, "message": "TradingView Desktop opened; session connected."})
            return session
        time.sleep(1.5)

    if cdp_reachable():
        session = verify_session()
        session.update({
            "launched": True,
            "error": "TradingView Desktop was opened, but no TradingView page is exposed yet. Sign in to Tradovate inside the app, then press Verify again.",
        })
        return session
    return {
        "ok": False,
        "code": "tv_cdp_timeout",
        "error": "TradingView Desktop was opened, but its automation port (CDP 9222) is not available. If the app was already running, quit it completely and press this again so Dwella can start it with automation enabled.",
        "tv_installed": True,
        "tv_path": path,
        "launched": True,
        "cdp_port": CDP_PORT,
    }


def _verify_only() -> dict:
    result = verify_session()
    result["launch_disabled"] = True
    return result


def _never_hide() -> dict:
    return {
        "ok": True,
        "hidden": False,
        "message": "Dwella never hides or controls the TradingView Desktop window",
    }


# Patch globals used by the imported market/scanner implementation. This is
# intentionally done before main() starts its polling threads. Every legacy
# install/launch/update helper becomes verify-only so an old code path cannot
# download, patch, hide, or start the proprietary desktop app.
impl._cdp_reachable = cdp_reachable
impl._tv_webview_present = tv_target_present
impl._tv_process_running = tv_process_running
impl.tv_app_path = tv_app_path
impl.ensure_tradingview = _verify_only
impl.install_tradingview = _verify_only
impl.patch_tv_updates = lambda *_args, **_kwargs: {"ok": False, "applied": False, "error": "TradingView updates are managed by the official app"}
impl.lock_tv_updater_cache = lambda: None
impl.restart_tradingview_with_cdp = _verify_only
impl.launch_tradingview = launch_tradingview
impl.hide_tradingview = _never_hide


_original_get = impl.Handler.do_GET
_original_post = impl.Handler.do_POST


def _get(self) -> None:
    path = self.path.split("?", 1)[0]
    if path == "/tv/check":
        self._send(200, check_payload())
        return
    if path == "/tv/status":
        state = self.server.state
        tv = impl._cached_tv_health()
        impl.expire_stale_account(state)
        with state.lock:
            account = dict(state.account or {})
            account_fresh = bool(
                account
                and not state.account_stale
                and impl.time.time() - state.account_observed_at <= impl.ACCOUNT_SNAPSHOT_GRACE
            )
            stale_symbols = [
                symbol for symbol in impl.CANDLE_SYMBOLS
                if impl.candles_are_stale(state.candles.get(symbol, []), "3")
            ]
        self._send(200, {
            "tv": tv,
            "connected": bool(tv.get("connected")) and cdp_reachable() and tv_target_present(),
            "account": account if account_fresh else {},
            "account_connected": account_fresh,
            "account_fresh": account_fresh,
            "account_source": "TradingView Desktop via local CDP" if account_fresh else None,
            "market_data_fresh": not stale_symbols,
            "market_data_stale_symbols": stale_symbols,
            "tv_installed": bool(tv_app_path()),
            "tv_path": tv_app_path(),
            "cdp_port": CDP_PORT,
        })
        return
    _original_get(self)


def _post(self) -> None:
    path = self.path.split("?", 1)[0]
    if path == "/tv/install":
        self._send(409, {
            "ok": False,
            "component": "tv",
            "code": "external_prerequisite",
            "error": "Dwella does not install or embed TradingView Desktop. Install it on this device, start it with CDP enabled, and sign into Tradovate there.",
            "tv_path": tv_app_path(),
        })
        return
    if path == "/tv/launch":
        # Open the already-installed TradingView Desktop app and wait for the
        # local CDP session. Download/embed/patch is still never performed.
        self._send(200, launch_tradingview())
        return
    if path == "/tv/fix":
        # Verify-only diagnostic; /tv/launch is the single open action.
        result = verify_session()
        result["launch_disabled"] = False
        self._send(200, result)
        return
    if path == "/tv/hide":
        self._send(200, _never_hide())
        return
    if path in ("/accounts/save", "/accounts/save-current"):
        # The legacy handler still includes an `armed` field for old clients.
        # Rewrite that response at the boundary so account selection can never
        # be mistaken for the explicit live `/scanner/arm` action.
        original_send = self._send

        def safe_send(code, payload):
            if code < 400 and isinstance(payload, dict):
                payload = dict(payload)
                if "armed" in payload:
                    payload["armed"] = False
                payload["message"] = (
                    "Account selection saved; automation remains disarmed"
                    if path == "/accounts/save"
                    else "Visible account selected; automation remains disarmed"
                )
            original_send(code, payload)

        self._send = safe_send
        try:
            _original_post(self)
        finally:
            self._send = original_send
        return
    _original_post(self)


impl.Handler.do_GET = _get
impl.Handler.do_POST = _post


if __name__ == "__main__":
    raise SystemExit(impl.main())
