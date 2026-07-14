const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const execFileAsync = promisify(execFile);

let win;
let hermesProcess = null;
const isDev = !app.isPackaged;
const configPath = () => path.join(app.getPath("userData"), "secure-config.json");

// ── Buffy API server ────────────────────────────────────────────────────────
// Freebuff/Buffy talks to Dwella through this local HTTP API on port 8645.
const BUFFY_PORT = 8645;
const buffyMessages = [];
const buffySignals = [];

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, data); } catch {}
  }
}

function buffyApiHandler(req, res) {
  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  const json = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const body = () => new Promise((resolve) => {
    if (req.method === "GET") return resolve({});
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });

  (async () => {
    try {
      // GET /health
      if (pathname === "/health" || pathname === "/") {
        return json(200, { ok: true, service: "buffy-api", port: BUFFY_PORT });
      }

      // POST /buffy/message — Send a message/analysis from Buffy
      if (pathname === "/buffy/message" && req.method === "POST") {
        const b = await body();
        const msg = {
          id: crypto.randomUUID(),
          sender: "Buffy",
          content: b.content || "",
          type: b.type || "chat",
          symbol: b.symbol || null,
          timestamp: Date.now(),
        };
        buffyMessages.push(msg);
        if (buffyMessages.length > 200) buffyMessages.shift();
        sendToRenderer("buffy:message", msg);
        return json(200, { ok: true, id: msg.id });
      }

      // POST /buffy/signal — Send a trade signal
      if (pathname === "/buffy/signal" && req.method === "POST") {
        const b = await body();
        const signal = {
          id: crypto.randomUUID(),
          symbol: b.symbol || "",
          action: b.action || "hold",
          confidence: Math.min(1, Math.max(0, b.confidence || 0)),
          reasoning: b.reasoning || "",
          entry: b.entry || null,
          stop: b.stop || null,
          target: b.target || null,
          timeframe: b.timeframe || "",
          timestamp: Date.now(),
        };
        buffySignals.push(signal);
        if (buffySignals.length > 100) buffySignals.shift();
        sendToRenderer("buffy:signal", signal);
        return json(200, { ok: true, id: signal.id });
      }

      // GET /buffy/messages — Get message history
      if (pathname === "/buffy/messages" && req.method === "GET") {
        const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
        return json(200, { ok: true, messages: buffyMessages.slice(-limit) });
      }

      // GET /buffy/signals — Get recent signals
      if (pathname === "/buffy/signals" && req.method === "GET") {
        return json(200, { ok: true, signals: buffySignals.slice(-20) });
      }

      // GET /buffy/markets — Proxy to MT5 bridge
      if (pathname === "/buffy/markets" && req.method === "GET") {
        try {
          const r = await fetch("http://127.0.0.1:8643/quotes", { signal: AbortSignal.timeout(5000) });
          const data = await r.json();
          return json(200, data);
        } catch {
          return json(503, { ok: false, message: "MT5 bridge unavailable" });
        }
      }

      // GET /buffy/positions — Proxy to MT5 bridge
      if (pathname === "/buffy/positions" && req.method === "GET") {
        try {
          const r = await fetch("http://127.0.0.1:8643/positions", { signal: AbortSignal.timeout(5000) });
          const data = await r.json();
          return json(200, data);
        } catch {
          return json(503, { ok: false, message: "MT5 bridge unavailable" });
        }
      }

      // GET /buffy/account — Proxy to MT5 bridge
      if (pathname === "/buffy/account" && req.method === "GET") {
        try {
          const r = await fetch("http://127.0.0.1:8643/account", { signal: AbortSignal.timeout(5000) });
          const data = await r.json();
          return json(200, data);
        } catch {
          return json(503, { ok: false, message: "MT5 bridge unavailable" });
        }
      }

      // GET /buffy/status — System + Buffy connection status
      if (pathname === "/buffy/status" && req.method === "GET") {
        const { hermesInstalled, hermesRunning, hermesApiHealthy, platform, version } = await getStatus();
        return json(200, {
          ok: true,
          buffy: { connected: true, port: BUFFY_PORT, uptime: process.uptime() },
          hermes: { installed: hermesInstalled, running: hermesRunning, apiHealthy: hermesApiHealthy, version },
          platform,
        });
      }

      // 404
      json(404, { ok: false, message: "Not found" });
    } catch (err) {
      json(500, { ok: false, message: err.message });
    }
  })();
}

function startBuffyApi() {
  const server = http.createServer(buffyApiHandler);
  server.listen(BUFFY_PORT, "127.0.0.1", () => {
    console.log(`[buffy-api] Listening on http://127.0.0.1:${BUFFY_PORT}`);
  });
  server.on("error", (err) => {
    console.error(`[buffy-api] ${err.message}`);
  });
  return server;
}

// ── End Buffy API ───────────────────────────────────────────────────────────

async function readConfig(){try{return JSON.parse(await fs.readFile(configPath(),"utf8"))}catch{return {}}}
async function writeConfig(value){await fs.mkdir(path.dirname(configPath()),{recursive:true});await fs.writeFile(configPath(),JSON.stringify(value,null,2),{mode:0o600})}
async function hermesBinary(){
  const candidates=[path.join(app.getPath("home"),".local/bin/hermes"),"/opt/homebrew/bin/hermes","/usr/local/bin/hermes"];
  for(const candidate of candidates){try{await fs.access(candidate);return candidate}catch{}}
  try{const {stdout}=await execFileAsync("/usr/bin/which",["hermes"]);return stdout.trim()}catch{return null}
}
async function health(){try{const response=await fetch("http://127.0.0.1:8642/health",{signal:AbortSignal.timeout(1800)});return response.ok}catch{return false}}
async function getStatus(){

  const binary=await hermesBinary(); let version="";
  if(binary){try{version=(await execFileAsync(binary,["--version"],{timeout:2500})).stdout.trim()}catch{}}
  const config=await readConfig();
  const zoConfigured = Boolean(config.zoToken);
  return {hermesInstalled:Boolean(binary),hermesRunning:Boolean(hermesProcess&&!hermesProcess.killed)||await health(),hermesApiHealthy:await health(),zoConfigured,platform:process.platform,version};
}
function createWindow(){
  win=new BrowserWindow({width:1512,height:982,minWidth:1080,minHeight:720,title:"Dwella",backgroundColor:"#030305",frame:false,webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  if(isDev) win.loadURL("http://127.0.0.1:5173"); else win.loadFile(path.join(__dirname,"../dist/index.html"));
  win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:"deny"}});
  win.on("maximize",()=>win.webContents.send("window:max-changed",true));
  win.on("unmaximize",()=>win.webContents.send("window:max-changed",false));
}
app.whenReady().then(()=>{
  createWindow();
  startBuffyApi();
  // Dwella is the skin: self-provision the MT5 engine (install if missing), run it hidden, start the bridge.
  setTimeout(()=>mt5Quotes().then(live=>{if(!live)ensureBridge();else mt5setup.launchEngineHidden()}),3000);
  app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});

ipcMain.handle("system:status",getStatus);
ipcMain.handle("auth:has-login",async()=>Boolean((await readConfig()).localPassword));
ipcMain.handle("auth:create",async(_,password)=>{if(typeof password!=="string"||password.length<6)return {ok:false,message:"Use at least 6 characters."};if(!safeStorage.isEncryptionAvailable())return {ok:false,message:"macOS secure storage is unavailable."};const config=await readConfig();config.localPassword=safeStorage.encryptString(password).toString("base64");await writeConfig(config);return {ok:true,message:"Local login created."}});
ipcMain.handle("auth:verify",async(_,password)=>{const config=await readConfig();if(!config.localPassword)return {ok:false,message:"No local login exists."};try{const stored=safeStorage.decryptString(Buffer.from(config.localPassword,"base64"));return stored===password?{ok:true,message:"Welcome back."}:{ok:false,message:"That password is incorrect."}}catch{return {ok:false,message:"The saved login could not be unlocked."}}});
ipcMain.handle("auth:clear",async()=>{const config=await readConfig();delete config.localPassword;await writeConfig(config);return {ok:true,message:"Local login removed."}});
ipcMain.handle("shell:open",async(_,url)=>{if(/^https:\/\//.test(url))await shell.openExternal(url)});
ipcMain.handle("hermes:start",async()=>{
  const binary=await hermesBinary(); if(!binary)return {ok:false,message:"Hermes is not installed. Run the guided installer first."};
  if(await health())return {ok:true,message:"Hermes is already online."};
  hermesProcess=spawn(binary,["gateway","run"],{detached:false,stdio:"ignore",env:{...process.env,PATH:`${path.dirname(binary)}:${process.env.PATH||""}`}}); hermesProcess.unref();
  await new Promise(r=>setTimeout(r,1800)); return (await health())?{ok:true,message:"Hermes gateway is online."}:{ok:false,message:"Hermes started but its local API is not healthy. Run hermes setup and enable the API server on port 8642."};
});
ipcMain.handle("hermes:stop",async()=>{if(hermesProcess&&!hermesProcess.killed){hermesProcess.kill("SIGTERM");hermesProcess=null;return {ok:true,message:"Hermes stopped."}}return {ok:false,message:"No Dwella-managed Hermes process is running."}});
ipcMain.handle("hermes:ask",async(_,input)=>{
  if(typeof input!=="string"||!input.trim()||input.length>8000)return {ok:false,message:"Enter a task under 8,000 characters."};
  const envPath=path.join(app.getPath("home"),".hermes/.env"); let env=""; try{env=await fs.readFile(envPath,"utf8")}catch{return {ok:false,message:"Hermes API is not configured yet."}}
  const key=env.match(/^API_SERVER_KEY=(.+)$/m)?.[1]?.trim(); if(!key)return {ok:false,message:"API_SERVER_KEY is missing from ~/.hermes/.env."};
  try{const response=await fetch("http://127.0.0.1:8642/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:"hermes-agent",conversation:"dwella-desktop",input:input.trim()}),signal:AbortSignal.timeout(120000)});const body=await response.text();if(!response.ok)return {ok:false,message:`Hermes returned ${response.status}.`,output:body};let parsed;try{parsed=JSON.parse(body)}catch{return {ok:true,message:"Hermes replied.",output:body}}return {ok:true,message:"Hermes replied.",output:parsed.output_text||parsed.output||parsed.response||JSON.stringify(parsed,null,2)}}catch(error){return {ok:false,message:`Could not reach Hermes: ${error.message}`}}
});

const QUOTE_SYMBOLS=[{s:"NQ",y:"NQ=F"},{s:"GC",y:"GC=F"},{s:"ES",y:"ES=F"}];
const FUTURES_SPECS={
  NQ:{name:"Nasdaq 100 E-mini",exchange:"CME",tick_size:0.25,point_value:20,micro:"MNQ",micro_point_value:2,continuous:["NQ#","NQ.US","NQ.CONT","@ENQ","ENQ"]},
  ES:{name:"S&P 500 E-mini",exchange:"CME",tick_size:0.25,point_value:50,micro:"MES",micro_point_value:5,continuous:["ES#","ES.US","ES.CONT","@EP","@ES","EP"]},
  GC:{name:"Gold (COMEX)",exchange:"COMEX",tick_size:0.1,point_value:100,micro:"MGC",micro_point_value:10,continuous:["GC#","GC.US","GC.CONT","@GCE","GCE"]},
};
const FUTURES_ROOTS=Object.keys(FUTURES_SPECS);
// Brokers we attempt to resolve futures symbols across (used for diagnostics/logging).
const FUTURES_BROKERS=["CQG","AMP","FXCM","Rithmic"];
const MT5_BRIDGE="http://127.0.0.1:8643";
const mt5setup=require("./mt5setup.cjs");
let lastBridgeSpawn=0, provisioning=false;
async function mt5Quotes(){
  try{const response=await fetch(`${MT5_BRIDGE}/quotes`,{signal:AbortSignal.timeout(5000)});if(!response.ok)return null;const body=await response.json();return body.ok&&Array.isArray(body.quotes)&&body.quotes.length?body.quotes:null}catch{return null}
}
async function ensureBridge(){
  if(provisioning||Date.now()-lastBridgeSpawn<60000)return; lastBridgeSpawn=Date.now();
  provisioning=true;
  try{await mt5setup.provision(msg=>{console.log("[mt5setup]",msg);if(win&&!win.isDestroyed())win.webContents.send("mt5:setup-progress",msg)})}
  catch(error){console.error("[mt5setup]",error.message)}
  finally{provisioning=false}
}
async function yahooQuotes(){
  return Promise.all(QUOTE_SYMBOLS.map(async({s,y})=>{
    try{
      const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1d&interval=5m`,{headers:{"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},signal:AbortSignal.timeout(8000)});
      if(!response.ok)return {s,ok:false};
      const meta=(await response.json())?.chart?.result?.[0]?.meta;
      const price=meta?.regularMarketPrice, prev=meta?.chartPreviousClose??meta?.previousClose;
      if(typeof price!=="number")return {s,ok:false};
      return {s,ok:true,price,changePct:typeof prev==="number"&&prev!==0?((price-prev)/prev)*100:null,src:"yahoo"};
    }catch{return {s,ok:false}}
  }));
}
async function bridgeJson(pathname){try{const response=await fetch(`${MT5_BRIDGE}${pathname}`,{signal:AbortSignal.timeout(8000)});if(!response.ok)return null;return await response.json()}catch{return null}}
const YAHOO_TF={M1:{interval:"1m",range:"1d"},M5:{interval:"5m",range:"5d"},M15:{interval:"15m",range:"5d"},M30:{interval:"30m",range:"1mo"},H1:{interval:"60m",range:"1mo"},H4:{interval:"60m",range:"3mo"},D1:{interval:"1d",range:"6mo"}};
async function yahooBars(s,tf,count){
  const symbol=QUOTE_SYMBOLS.find(q=>q.s===s)?.y; const cfg=YAHOO_TF[tf]||YAHOO_TF.M5;
  if(!symbol)return null;
  try{
    const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${cfg.range}&interval=${cfg.interval}`,{headers:{"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},signal:AbortSignal.timeout(8000)});
    if(!response.ok)return null;
    const result=(await response.json())?.chart?.result?.[0];
    const ts=result?.timestamp,q=result?.indicators?.quote?.[0];
    if(!Array.isArray(ts)||!q)return null;
    const bars=[];
    for(let i=0;i<ts.length;i++){const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i];if([o,h,l,c].every(v=>typeof v==="number"))bars.push({t:ts[i]*1000,o,h,l,c,v:q.volume?.[i]||0})}
    return bars.length?{ok:true,symbol,tf,src:"yahoo",bars:bars.slice(-(count||180))}:null;
   }catch{return null}
}

// ── Futures fallback (when MT5 bridge is offline) ────────────────────────────
const MONTH_CODES={F:1,G:2,H:3,J:4,K:5,M:6,N:7,Q:8,U:9,V:10,X:11,Z:12};
const CODE_FOR_MONTH=Object.fromEntries(Object.entries(MONTH_CODES).map(([k,v])=>[v,k]));
function thirdFriday(year,month){const first=new Date(Date.UTC(year,month-1,1));const offset=(5-first.getUTCDay()+7)%7;const d=new Date(first);d.setUTCDate(1+offset+7*2);return d;}
function thirdLastBusinessDay(year,month){const nxt=month===12?new Date(Date.UTC(year+1,0,1)):new Date(Date.UTC(year,month,1));const d=new Date(nxt);d.setUTCDate(d.getUTCDate()-1);let seen=0;while(seen<3){if(d.getUTCDay()<5)seen++;d.setUTCDate(d.getUTCDate()-1);}d.setUTCDate(d.getUTCDate()+1);return d;}
function contractExpiration(underlying,year,month){const metal=(underlying==="GC"||underlying==="MGC");return (metal?thirdLastBusinessDay:thirdFriday)(year,month).toISOString().slice(0,10);}
function buildStaticChain(underlying){
  const spec=FUTURES_SPECS[underlying];
  if(!spec)return {ok:false,error:"unknown_underlying",underlying};
  const now=new Date();let y=now.getUTCFullYear(),m=now.getUTCMonth()+1;
  const contracts=[];
  for(let i=0;i<8;i++){
    const code=CODE_FOR_MONTH[m];
    const yy=String(y).slice(2);
    for(const root of [underlying,spec.micro]){
      const pv=root===spec.micro?spec.micro_point_value:spec.point_value;
      const tick=spec.tick_size;
      contracts.push({symbol:`${root}${code}${yy}`,underlying,root,month:m,year:y,month_code:code,
        expiration:contractExpiration(root,y,m),tick_size:tick,point_value:pv,tick_value:+(tick*pv).toFixed(4),
        contract_size:pv,margin:spec.margin,exchange:spec.exchange,name:spec.name});
    }
    m++;if(m>12){m=1;y++;}
  }
  return {ok:true,underlying,continuous:spec.continuous,contracts,spec};
}
ipcMain.handle("markets:bars",async(_,s,tf,count)=>{
  if(FUTURES_ROOTS.includes(s)){
    const cont=await bridgeJson(`/futures/continuous?s=${encodeURIComponent(s)}&tf=${encodeURIComponent(tf)}&count=${encodeURIComponent(count||180)}`);
    if(cont&&cont.ok&&Array.isArray(cont.bars)&&cont.bars.length)return {src:"mt5",...cont};
  }
  const live=await bridgeJson(`/bars?s=${encodeURIComponent(s)}&tf=${encodeURIComponent(tf)}&count=${encodeURIComponent(count||180)}`);
  if(live&&live.ok&&Array.isArray(live.bars)&&live.bars.length)return {src:"mt5",...live};
  return await yahooBars(s,tf,count)||{ok:false};
});
// Futures roots (NQ/ES/GC) route through the rollover-aware continuous endpoint
// when live, otherwise fall back to the underlying Yahoo continuous future.
ipcMain.handle("markets:futures-bars",async(_,s,tf,count)=>{
  if(FUTURES_ROOTS.includes(s)){
    const live=await bridgeJson(`/futures/continuous?s=${encodeURIComponent(s)}&tf=${encodeURIComponent(tf)}&count=${encodeURIComponent(count||180)}`);
    if(live&&live.ok&&Array.isArray(live.bars)&&live.bars.length)return {src:"mt5",...live};
  }
  return await yahooBars(s,tf,count)||{ok:false};
});
ipcMain.handle("markets:futures-chain",async(_,s)=>{
  const live=await bridgeJson(`/futures/chain?s=${encodeURIComponent(s)}`);
  if(live&&live.ok&&Array.isArray(live.contracts))return {src:"mt5",...live};
  // Graceful fallback: synthesize the chain from static specs (no MT5 needed).
  return {src:"static",...buildStaticChain(s)};
});
ipcMain.handle("markets:futures-spec",async(_,s)=>{
  const live=await bridgeJson(`/futures/spec?s=${encodeURIComponent(s)}`);
  if(live&&live.ok)return {src:"mt5",...live};
  const spec=FUTURES_SPECS[s];
  if(!spec)return {ok:false,error:"unknown_underlying",underlying:s};
  return {ok:true,underlying:s,spec,continuous:spec.continuous};
});
ipcMain.handle("markets:account",async()=>await bridgeJson("/account")||{ok:false});
ipcMain.handle("markets:positions",async()=>await bridgeJson("/positions")||{ok:false});
ipcMain.handle("markets:quotes",async()=>{
  const live=await mt5Quotes();
  if(live&&live.length>=QUOTE_SYMBOLS.length)return live;
  if(!live)ensureBridge();
  const yahoo=await yahooQuotes();
  return QUOTE_SYMBOLS.map(({s})=>live?.find(q=>q.s===s)||yahoo.find(q=>q.s===s)||{s,ok:false});
});
ipcMain.handle("window:minimize",()=>{if(win)win.minimize()});
ipcMain.handle("window:toggle-maximize",()=>{if(!win)return;if(win.isMaximized())win.unmaximize();else win.maximize()});
ipcMain.handle("window:close",()=>{if(win)win.close()});
ipcMain.handle("window:is-maximized",()=>Boolean(win&&win.isMaximized()));

// ── Buffy IPC channels ──────────────────────────────────────────────────────
ipcMain.handle("buffy:history",async()=>buffyMessages.slice(-100));
ipcMain.handle("buffy:signals",async()=>buffySignals.slice(-20));
// ── End Buffy IPC ───────────────────────────────────────────────────────────

