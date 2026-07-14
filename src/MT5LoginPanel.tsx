import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface Mt5Profile {
  name: string;
  login: string;
  password: string;
  server: string;
  isDefault?: boolean;
}
interface Mt5Status {
  ok?: boolean;
  connected?: boolean;
  broker?: string | null;
  server?: string | null;
  detail?: string;
}

export default function MT5LoginPanel({ onConnected }: { onConnected: () => void }) {
  const [profiles, setProfiles] = useState<Mt5Profile[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");
  const [profileName, setProfileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Mt5Status>({ connected: false });
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadProfiles();
    const unsub = window.dwella.mt5.onStatus((s) => {
      setStatus(s);
      if (s.connected) onConnected();
    });
    return unsub;
  }, []);

  useEffect(() => { loadProfiles(); }, [selectedName]);

  async function loadProfiles() {
    const result = await window.dwella.mt5.getProfiles().catch(() => ({ ok: false, profiles: [] }));
    if (result.ok && result.profiles) {
      setProfiles(result.profiles);
      if (result.profiles.length && !selectedName) setSelectedName(result.profiles[0].name);
    }
  }

  useEffect(() => {
    const p = profiles.find((x) => x.name === selectedName);
    if (p) { setLogin(p.login); setPassword(p.password); setServer(p.server); }
  }, [selectedName]);

  async function testLogin() {
    setError("");
    setBusy(true);
    const result = await window.dwella.mt5.testLogin({ name: profileName || login, login, password, server }).catch(() => ({ ok: false, message: "Bridge unavailable." }));
    setBusy(false);
    if (!result.ok) setError(result.message || "Test login failed.");
    else { setError(""); setStatus({ connected: true, broker: (result as any).data?.company, server: (result as any).data?.server }); }
  }

  async function doLogin() {
    setError("");
    setBusy(true);
    const result = await window.dwella.mt5.login({ name: profileName || `${login}`, login, password, server }).catch(() => ({ ok: false, message: "Bridge unavailable." }));
    setBusy(false);
    if (!result.ok) setError(result.message || "Login failed.");
    else { setError(""); setStatus({ connected: true, broker: (result as any).data?.company, server: (result as any).data?.server }); onConnected(); }
  }

  async function doLogout() {
    setBusy(true);
    await window.dwella.mt5.logout().catch(() => ({}));
    setBusy(false);
    setStatus({ connected: false });
  }

  async function removeProfile() {
    if (!selectedName) return;
    setBusy(true);
    await window.dwella.mt5.deleteProfile({ name: selectedName }).catch(() => ({}));
    setSelectedName("");
    setLogin(""); setPassword(""); setServer("");
    setBusy(false);
    loadProfiles();
  }

  return (
    <motion.div className="mt5-login-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="mt5-login-card">
        <div className="mt5-login-head">
          <div className="mt5-login-brand"><b>d</b><span>MT5</span></div>
          <h2>Broker Connection</h2>
          <p className={`mt5-conn-dot ${status.connected ? "live" : "off"}`}>
            <i />{status.connected ? (status.broker || "Connected") : "Disconnected"}
          </p>
        </div>

        {profiles.length > 0 && !showForm && (
          <div className="mt5-profiles">
            {profiles.map((p) => (
              <button key={p.name} className={`profile-chip ${p.name === selectedName ? "active" : ""}`} onClick={() => { setSelectedName(p.name); setLogin(p.login); setPassword(p.password); setServer(p.server); }}>
                <b>{p.name}</b><small>{p.server || p.login}</small>
              </button>
            ))}
          </div>
        )}

        {showForm ? (
          <div className="mt5-login-form">
            <label>Profile name<input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="My Broker" /></label>
            <label>Login ID<input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Broker login / account number" /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Investor or main password" /></label>
            <label>Server<input value={server} onChange={(e) => setServer(e.target.value)} placeholder="e.g. MetaQuotes-Demo" /></label>
            {error && <div className="mt5-error">{error}</div>}
            <div className="mt5-form-actions">
              <button disabled={busy || !login || !password} onClick={doLogin}>{busy ? "Connecting…" : "Connect & Save"}</button>
              <button className="ghost" disabled={busy} onClick={testLogin}>Test only</button>
            </div>
          </div>
        ) : (
          <div className="mt5-login-actions">
            {status.connected ? (
              <button disabled={busy} onClick={doLogout}>Disconnect broker</button>
            ) : (
              <>
                <button disabled={busy || !login || !password} onClick={doLogin}>Connect with saved profile</button>
                <button className="ghost" onClick={() => { setShowForm(true); setProfileName(""); setError(""); }}>+ New profile</button>
                {selectedName && <button className="ghost danger" disabled={busy} onClick={removeProfile}>Delete profile</button>}
              </>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
