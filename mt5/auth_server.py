#!/usr/bin/env python3
"""
auth_server.py — Dwella local user authentication.

Provides register/login endpoints with PBKDF2 password hashing and JWT sessions.
Stores users in SQLite database. Saves credentials to macOS Keychain.

Endpoints (JSON):
    POST /auth/register       -> { ok, user, token }
    POST /auth/login          -> { ok, user, token }
    GET  /auth/me             -> { user } (requires Authorization header)
    POST /auth/logout         -> { ok }
    GET  /auth/keychain       -> { ok, username, hasPassword }
    POST /auth/keychain/save  -> { ok }
    POST /auth/keychain/delete -> { ok }

Run:  python3 auth_server.py           (default: http 127.0.0.1:18815)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
import secrets

# ── Password hashing (PBKDF2-HMAC-SHA256) ────────────────────────────
SALT_LENGTH = 32
HASH_ITERATIONS = 100_000
KEYCHAIN_SERVICE = "dwella"

def hash_password(password: str) -> str:
    salt = secrets.token_hex(SALT_LENGTH)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), HASH_ITERATIONS)
    return f"{salt}:{dk.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, hash_hex = stored.split(":", 1)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), HASH_ITERATIONS)
        return dk.hex() == hash_hex
    except Exception:
        return False

# ── JWT-like token ────────────────────────────────────────────────────
TOKEN_SECRET = secrets.token_hex(32)
TOKEN_EXPIRY_HOURS = 24 * 7  # 7 days

def create_token(user_id: int, username: str) -> str:
    payload = {
        "user_id": user_id,
        "username": username,
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRY_HOURS)).timestamp()),
        "iat": int(datetime.now(timezone.utc).timestamp()),
    }
    data = json.dumps(payload, separators=(",", ":"))
    sig = hashlib.sha256((data + TOKEN_SECRET).encode()).hexdigest()
    return base64.urlsafe_b64encode(data.encode()).decode() + "." + sig

def verify_token(token: str) -> Optional[dict]:
    try:
        data_part, sig = token.rsplit(".", 1)
        data = base64.urlsafe_b64decode(data_part + "==").decode()
        expected_sig = hashlib.sha256((data + TOKEN_SECRET).encode()).hexdigest()
        if sig != expected_sig:
            return None
        payload = json.loads(data)
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

# ── macOS Keychain helpers ────────────────────────────────────────────
def keychain_save(username: str, password: str) -> bool:
    try:
        subprocess.run(
            ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username],
            capture_output=True, timeout=5
        )
        result = subprocess.run(
            ["security", "add-generic-password",
             "-s", KEYCHAIN_SERVICE, "-a", username, "-w", password, "-U"],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False

def keychain_load() -> Optional[dict]:
    try:
        # Use -g to get all fields including account name
        result = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-g"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return None
        # Parse account (username) and password from output
        username = ""
        password = ""
        for line in result.stderr.splitlines():
            if "\"acct\"" in line or "\"svce\"" not in line:
                # Look for acct field
                if "acct" in line:
                    parts = line.split('"')
                    if len(parts) >= 4:
                        username = parts[3]
        # Get password separately
        result2 = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=5
        )
        if result2.returncode == 0 and result2.stdout.strip():
            password = result2.stdout.strip()
        if password:
            return {"username": username, "password": password}
    except Exception:
        pass
    return None

def keychain_delete() -> bool:
    try:
        result = subprocess.run(
            ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE],
            capture_output=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False

# ── Database ──────────────────────────────────────────────────────────
class UserDB:
    def __init__(self, db_path: str) -> None:
        self.lock = threading.Lock()
        self.db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        with self.lock:
            conn = sqlite3.connect(self.db_path)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    email TEXT,
                    password_hash TEXT NOT NULL,
                    display_name TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    last_login TEXT
                )
            """)
            conn.commit()
            conn.close()

    def register(self, username: str, password: str, email: str = "", display_name: str = "") -> Optional[dict]:
        with self.lock:
            conn = sqlite3.connect(self.db_path)
            try:
                row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
                if row:
                    return None
                if email:
                    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
                    if row:
                        return None
                pw_hash = hash_password(password)
                cursor = conn.execute(
                    "INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)",
                    (username, email, pw_hash, display_name or username)
                )
                conn.commit()
                return {
                    "id": cursor.lastrowid,
                    "username": username,
                    "email": email,
                    "display_name": display_name or username,
                }
            finally:
                conn.close()

    def login(self, username: str, password: str) -> Optional[dict]:
        with self.lock:
            conn = sqlite3.connect(self.db_path)
            try:
                row = conn.execute(
                    "SELECT id, username, email, display_name, password_hash FROM users WHERE username = ? OR email = ?",
                    (username, username)
                ).fetchone()
                if not row:
                    return None
                user_id, uname, email, display_name, pw_hash = row
                if not verify_password(password, pw_hash):
                    return None
                conn.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (user_id,))
                conn.commit()
                return {
                    "id": user_id,
                    "username": uname,
                    "email": email or "",
                    "display_name": display_name or uname,
                }
            finally:
                conn.close()

    def get_user(self, user_id: int) -> Optional[dict]:
        with self.lock:
            conn = sqlite3.connect(self.db_path)
            try:
                row = conn.execute(
                    "SELECT id, username, email, display_name, created_at, last_login FROM users WHERE id = ?",
                    (user_id,)
                ).fetchone()
                if not row:
                    return None
                return {
                    "id": row[0], "username": row[1], "email": row[2] or "",
                    "display_name": row[3] or row[1], "created_at": row[4], "last_login": row[5],
                }
            finally:
                conn.close()


# ── HTTP handler ──────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:
        pass

    def _send(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def _get_auth_user(self) -> Optional[dict]:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        token = auth[7:]
        payload = verify_token(token)
        if not payload:
            return None
        db: UserDB = self.server.db
        return db.get_user(payload["user_id"])

    def do_GET(self) -> None:
        path = self.path.split("?")[0]

        if path == "/auth/me":
            user = self._get_auth_user()
            if not user:
                self._send(401, {"ok": False, "error": "Not authenticated"}); return
            self._send(200, {"ok": True, "user": user}); return

        if path == "/auth/keychain":
            creds = keychain_load()
            if creds:
                self._send(200, {"ok": True, "username": creds["username"], "hasPassword": True})
            else:
                self._send(200, {"ok": True, "username": "", "hasPassword": False})
            return

        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        db: UserDB = self.server.db
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        if path == "/auth/register":
            username = body.get("username", "").strip()
            password = body.get("password", "")
            email = body.get("email", "").strip()
            display_name = body.get("display_name", "").strip()
            if not username or not password:
                self._send(400, {"ok": False, "error": "username and password required"}); return
            if len(username) < 3:
                self._send(400, {"ok": False, "error": "username must be at least 3 characters"}); return
            if len(password) < 6:
                self._send(400, {"ok": False, "error": "password must be at least 6 characters"}); return
            user = db.register(username, password, email, display_name)
            if not user:
                self._send(409, {"ok": False, "error": "Username already exists"}); return
            token = create_token(user["id"], user["username"])
            keychain_save(username, password)
            self._send(200, {"ok": True, "user": user, "token": token}); return

        if path == "/auth/login":
            username = body.get("username", "").strip()
            password = body.get("password", "")
            if not username or not password:
                self._send(400, {"ok": False, "error": "username and password required"}); return
            user = db.login(username, password)
            if not user:
                self._send(401, {"ok": False, "error": "Invalid username or password"}); return
            token = create_token(user["id"], user["username"])
            keychain_save(username, password)
            self._send(200, {"ok": True, "user": user, "token": token}); return

        if path == "/auth/logout":
            self._send(200, {"ok": True}); return

        if path == "/auth/keychain/save":
            username = body.get("username", "").strip()
            password = body.get("password", "")
            if not username or not password:
                self._send(400, {"ok": False, "error": "username and password required"}); return
            ok = keychain_save(username, password)
            self._send(200, {"ok": ok}); return

        if path == "/auth/keychain/delete":
            ok = keychain_delete()
            self._send(200, {"ok": ok}); return

        self._send(404, {"error": "not found"})


# ── Main ──────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=18815)
    args = parser.parse_args(argv)

    runtime_dir = os.environ.get(
        "DWELLA_RUNTIME_DIR",
        os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"),
    )
    db_path = os.path.join(runtime_dir, "dwella_auth.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    db = UserDB(db_path)

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    server.db = db

    def _stop(_sig, _frame):
        print("\nShutting down...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    print(f"Dwella auth server listening on http://{args.http_host}:{args.http_port}", flush=True)
    print(f"Database: {db_path}", flush=True)
    try:
        server.serve_forever()
    finally:
        os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
