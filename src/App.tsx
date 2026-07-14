import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import bootVideo from "./assets/boot-loop.mp4";
import loginVideo from "./assets/login-loop.mp4";
import CandleChart from "./CandleChart";
import ReplayPanel from "./ReplayPanel";
import BacktestPanel from "./BacktestPanel";
import TradingPanel from "./TradingPanel";
import AutoTraderPanel from "./AutoTraderPanel";

const baseMarkets=[{s:"NQ",n:"Nasdaq 100 E-mini",v:"—",p:"…",c:"violet"},{s:"GC",n:"Gold Futures",v:"—",p:"…",c:"gold"},{s:"ES",n:"S&P 500 E-mini",v:"—",p:"…",c:"blue"}];
const trades=[{s:"NQ",n:"Nasdaq 100 E-mini",side:"Long",q:"2",entry:"18,512.50",exit:"18,642.75",p:"+$260.50",status:"Confirmed"},{s:"GC",n:"Gold Futures",side:"Short",q:"1",entry:"2,361.40",exit:"2,346.80",p:"+$1,460.00",status:"Protected"},{s:"ES",n:"S&P 500 E-mini",side:"Short",q:"1",entry:"5,392.50",exit:"5,382.25",p:"+$512.50",status:"Confirmed"}];
const fmtPrice=(v:number)=>v.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct=(v:number)=>`${v>=0?"+":""}${v.toFixed(2)}%`;

function Spark({gold=false}:{gold?:boolean}){return <svg className="spark" viewBox="0 0 120 34"><path d="M2 29 C18 31 24 20 35 20 S50 5 62 16 S80 26 91 9 S106 11 118 4" fill="none" stroke={gold?"#f0ad4e":"#7487ff"} strokeWidth="2"/></svg>}

function Dot({on}:{on:boolean}){return <i className={on?"dot on":"dot"}/>}

function TitleBar(){
  const [max,setMax]=useState(false);
  useEffect(()=>{
    let active=true;
    const wc=window.dwella.windowControls;
    wc.isMaximized().then(v=>{if(active)setMax(v)}).catch(()=>{});
    const off=wc.onMaxChanged(v=>{if(active)setMax(v)});
    return()=>{active=false;off();};
  },[]);
  return <header className="custom-titlebar">
    <div className="titlebar-drag" onDoubleClick={()=>window.dwella.windowControls.toggleMaximize()} aria-label="Drag window"/>
    <div className="titlebar-controls">
      <button type="button" aria-label="Minimize" title="Minimize" onClick={()=>window.dwella.windowControls.minimize()}>−</button>
      <button type="button" aria-label={max?"Restore":"Maximize"} title={max?"Restore":"Maximize"} onClick={()=>window.dwella.windowControls.toggleMaximize()}>{max?"❐":"▢"}</button>
      <button type="button" aria-label="Close" title="Close" className="close" onClick={()=>window.dwella.windowControls.close()}>✕</button>
    </div>
  </header>;
}

function DesktopDashboard(){
  const [status,setStatus]=useState<SystemStatus>({hermesInstalled:false,hermesRunning:false,hermesApiHealthy:false,platform:""});
  const [panel,setPanel]=useState<"overview"|"terminal"|"replay"|"settings"|"buffy"|"backtest"|"autotrader">("overview");
  const [buffyMsgs,setBuffyMsgs]=useState<BuffyMessage[]>([]);
  const [buffySigs,setBuffySigs]=useState<BuffySignal[]>([]);
  const [buffyStatus,setBuffyStatus]=useState<"connecting"|"online"|"offline">("connecting");
  const [account,setAccount]=useState<AccountSummary|null>(null);
  const [positions,setPositions]=useState<Mt5Position[]>([]);
  const [chartSym,setChartSym]=useState("NQ");
  const [chartTf,setChartTf]=useState("M5");
  const [chartBars,setChartBars]=useState<MarketBar[]>([]);
  const [chartSource,setChartSource]=useState("");
  const [chartSrc,setChartSrc]=useState("");
  const [markets,setMarkets]=useState(baseMarkets);
  const refresh=async()=>{const s=await window.dwella.getSystemStatus();setStatus(s)};
  useEffect(()=>{refresh();const id=setInterval(refresh,5000);return()=>clearInterval(id)},[]);

  // ── Buffy lifecycle ──────────────────────────────────────────────────
  useEffect(()=>{
    let active=true;
    const load=async()=>{
      const [hist,sigs]=await Promise.all([
        window.dwella.buffy.getHistory().catch(()=>[]),
        window.dwella.buffy.getSignals().catch(()=>[]),
      ]);
      if(!active)return;
      if(hist)setBuffyMsgs(hist);
      if(sigs)setBuffySigs(sigs);
      // Check if Buffy API is reachable
      try{
        const r=await fetch("http://127.0.0.1:8645/health",{signal:AbortSignal.timeout(2000)});
        const b=await r.json();
        if(active)setBuffyStatus(b.ok?"online":"offline");
      }catch{if(active)setBuffyStatus("offline")}
    };
    load();
    const offMsg=window.dwella.buffy.onMessage(msg=>{if(active)setBuffyMsgs(prev=>[...prev.slice(-99),msg])});
    const offSig=window.dwella.buffy.onSignal(sig=>{if(active)setBuffySigs(prev=>[...prev.slice(-19),sig])});
    const id=setInterval(load,15000);
    return()=>{active=false;offMsg();offSig();clearInterval(id)};
  },[]);
  // ── End Buffy lifecycle ──────────────────────────────────────────────

  useEffect(()=>{
    let active=true;
    const load=async()=>{try{const quotes=await window.dwella.getMarketQuotes();if(!active)return;setMarkets(prev=>baseMarkets.map(b=>{const q=quotes.find(x=>x.s===b.s);const old=prev.find(m=>m.s===b.s)||b;return q?.ok&&typeof q.price==="number"?{...b,n:q.src==="mt5"?`${b.n} · MT5 live`:b.n,v:fmtPrice(q.price),p:typeof q.changePct==="number"?fmtPct(q.changePct):old.p}:old}))}catch{}};
    load();const id=setInterval(load,30000);
    return()=>{active=false;clearInterval(id)};
  },[]);
  useEffect(()=>{
    let active=true;
    const load=async()=>{try{
      const [acct,poss]=await Promise.all([window.dwella.getAccount(),window.dwella.getPositions()]);
      if(!active)return;
      setAccount(acct?.ok?acct:null);
      setPositions(poss?.ok&&poss.positions?poss.positions:[]);
    }catch{}};
    load();const id=setInterval(load,10000);
    return()=>{active=false;clearInterval(id)};
  },[]);
  useEffect(()=>{
    let active=true;
    const load=async()=>{try{
      const result=await window.dwella.getMarketBars(chartSym,chartTf,180);
      if(!active)return;
      if(result?.ok&&result.bars){setChartBars(result.bars);setChartSource(result.symbol||"");setChartSrc(result.src||"mt5")}
    }catch{}};
    setChartBars([]);load();const id=setInterval(load,20000);
    return()=>{active=false;clearInterval(id)};
  },[chartSym,chartTf]);
  return <div className="app-shell">
    <aside className="rail"><div className="brand">d</div><nav><button className={panel==="overview"?"active":""} onClick={()=>setPanel("overview")}>▦<span>Overview</span></button><button className={panel==="terminal"?"active":""} onClick={()=>setPanel("terminal")}>◫<span>Terminal</span></button><button className={panel==="replay"?"active":""} onClick={()=>setPanel("replay")}>⏪<span>Replay</span></button><button className={panel==="buffy"?"active":""} onClick={()=>setPanel("buffy")}>✦<span>Buffy</span></button><button className={panel==="backtest"?"active":""} onClick={()=>setPanel("backtest")}>📈<span>Backtest</span></button><button className={panel==="autotrader"?"active":""} onClick={()=>setPanel("autotrader")}>⚡<span>AutoTrader</span></button></nav><div className="rail-bottom"><button className={panel==="settings"?"active":""} onClick={()=>setPanel("settings")}>⚙<span>Settings</span></button></div></aside>
    <main className="workspace">
      <header className="topbar"><div><p>Dwella / <b>{panel[0].toUpperCase()+panel.slice(1)}</b></p>        <h1>{panel==="overview"?"Hello Gideon":panel==="terminal"?"Trading Terminal":panel==="replay"?"Market Replay":panel==="buffy"?"Buffy":panel==="autotrader"?"AutoTrader":"Local Settings"}</h1>          <span>{panel==="overview"?"Your strategy is calm, protected, and ready.":panel==="terminal"?`Your broker feed wearing Dwella${account?.server?` · ${account.server}`:""}`:panel==="replay"?"Step through historical MT5 bars and practice trading.":panel==="buffy"?"Your AI trading brain, connected via Freebuff.":panel==="autotrader"?"Automated strategy execution with risk enforcement.":"Credentials stay encrypted on this device."}</span></div><div className="global-state"><span><Dot on={status.hermesApiHealthy}/>Local runtime</span><span className={`buffy-dot ${buffyStatus}`}><Dot on={buffyStatus==="online"}/>Buffy</span></div></header>
      <AnimatePresence mode="wait">
      {panel==="overview"&&<motion.div key="overview" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
        <section className="top-grid"><article className="equity glass"><div className="card-head"><span>Account equity</span><div><button>⇩ Deposit</button><button>⇧ Withdraw</button></div></div><h2>{account?.ok&&typeof account.equity==="number"?`$${fmtPrice(account.equity)}`:"$51,284.72"}</h2><p>{account?.ok&&typeof account.profit==="number"?<><b>{`${account.profit>=0?"+":"-"}$${fmtPrice(Math.abs(account.profit))}`}</b> open P&amp;L · live from MT5</>:<><b>+$1,048.72</b> this month</>}</p><div className="metrics"><span><b>2.34%</b><small>Monthly performance</small></span><span><b>75%</b><small>Strategy win rate</small></span><span><b>0.64</b><small>Market resilience</small></span><span><b>82<em>/100</em></b><small>Risk strength</small></span></div></article>
        <article className="exposure glass"><h3>Exposure overview</h3><div className="donut"><span><b>100%</b>Total</span></div><ul><li><i className="v"/>Nasdaq futures <b>44%</b></li><li><i className="g"/>Gold futures <b>26%</b></li><li><i className="b"/>S&amp;P futures <b>18%</b></li><li><i/>Available <b>12%</b></li></ul></article></section>
        <section className="markets">{markets.map(m=><article className={`market glass ${m.c}`} key={m.s}><i>{m.s}</i><span><small>{m.n}</small><b>{m.v}</b><em>{m.p}</em></span><Spark gold={m.c==="gold"}/></article>)}</section>
        <section className="bottom-grid"><article className="activity glass"><div className="section-head"><h3>Execution activity</h3><span>Paper trading environment</span></div><div className="trade labels"><span>Instrument</span><span>Side</span><span>Quantity</span><span>Entry</span><span>Exit</span><span>P&amp;L</span><span>Status</span></div>{trades.map(t=><div className="trade" key={t.s}><span><b>{t.s}</b><small>{t.n}</small></span><em>{t.side}</em><span>{t.q}</span><span>{t.entry}</span><span>{t.exit}</span><strong>{t.p}</strong><i>{t.status}</i></div>)}</article><article className="performance glass"><span>Strategy performance</span><h2>+7.52%</h2><h3>Momentum Flow</h3><p>NQ · ES strategy</p><svg viewBox="0 0 320 135"><path d="M0 115 C35 101 48 105 72 79 S115 91 141 60 S183 73 214 45 S260 55 320 10" fill="none" stroke="#f0a742" strokeWidth="3"/></svg></article></section>
      </motion.div>}
      {panel==="terminal"&&<motion.div key="terminal" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
        <TradingPanel
          account={account}
          positions={positions}
          markets={markets}
          chartSym={chartSym}
          setChartSym={setChartSym}
          chartTf={chartTf}
          setChartTf={setChartTf}
          chartBars={chartBars}
          chartSource={chartSource}
          chartSrc={chartSrc}
        />
      </motion.div>}
      {panel==="buffy"&&<motion.div className="buffy-layout" key="buffy" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
        <section className="buffy-status glass">
          <div className="buffy-status-head">
            <div className="buffy-avatar">✦</div>
            <div>
              <span>AI TRADING BRAIN</span>
              <h2>Buffy</h2>
              <p>Connected via Freebuff · Analyzes markets, generates signals, sends them here.</p>
            </div>
            <i className={`state ${buffyStatus==="online"?"live":""}`}>{buffyStatus.toUpperCase()}</i>
          </div>
          <div className="buffy-stats">
            <span><b>{buffyStatus==="online"?"Connected":"Disconnected"}</b><small>Status</small></span>
            <span><b>{buffySigs.length}</b><small>Signals today</small></span>
            <span><b>{buffyMsgs.length}</b><small>Messages</small></span>
            <span><b>8645</b><small>API port</small></span>
          </div>
        </section>

        {buffySigs.length>0&&<section className="buffy-signals glass">
          <div className="section-head"><h3>Latest Signals</h3><span>{buffySigs.length} total</span></div>
          {buffySigs.slice(-5).reverse().map(s=><div className={`buffy-signal ${s.action}`} key={s.id}>
            <div className="sig-top">
              <span className="sig-sym">{s.symbol}</span>
              <span className={`sig-action ${s.action}`}>{s.action.toUpperCase()}</span>
              <span className="sig-conf">{(s.confidence*100).toFixed(0)}% confidence</span>
              <span className="sig-time">{new Date(s.timestamp).toLocaleTimeString()}</span>
            </div>
            <p className="sig-reasoning">{s.reasoning}</p>
            <div className="sig-levels">
              {s.entry!==null&&<span><small>Entry</small><b>{s.entry.toLocaleString()}</b></span>}
              {s.stop!==null&&<span><small>Stop</small><b className="neg">{s.stop.toLocaleString()}</b></span>}
              {s.target!==null&&<span><small>Target</small><b className="pos">{s.target.toLocaleString()}</b></span>}
              {s.timeframe&&<span><small>TF</small><b>{s.timeframe}</b></span>}
            </div>
          </div>)}
        </section>}

        <section className="buffy-messages glass">
          <div className="section-head"><h3>Message Feed</h3><span>From your AI brain</span></div>
          <div className="buffy-msgs">
            {buffyMsgs.length===0&&<p className="buffy-empty">No messages yet. Buffy will appear here when she analyzes the markets.</p>}
            {buffyMsgs.slice(-30).reverse().map(m=><div className={`buffy-msg ${m.type}`} key={m.id}>
              <div className="buffy-msg-head">
                <span className="buffy-msg-sender">{m.sender}</span>
                {m.symbol&&<span className="buffy-msg-sym">{m.symbol}</span>}
                <span className="buffy-msg-type">{m.type}</span>
                <span className="buffy-msg-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
              </div>
              <p className="buffy-msg-body">{m.content}</p>
            </div>)}
          </div>
        </section>

        <section className="buffy-quickref glass">
          <div className="section-head"><h3>API Reference</h3><span>For Buffy to call from Freebuff</span></div>
          <div className="buffy-endpoints">
            <div><code>POST /buffy/message</code><span>Send analysis/chat to display</span></div>
            <div><code>POST /buffy/signal</code><span>Send a trade signal with action/confidence</span></div>
            <div><code>GET /buffy/markets</code><span>Get current market quotes via MT5</span></div>
            <div><code>GET /buffy/positions</code><span>Get open positions via MT5</span></div>
            <div><code>GET /buffy/status</code><span>Check system + Buffy connection status</span></div>
          </div>
          <p className="buffy-port">API running on <code>http://127.0.0.1:8645</code></p>
        </section>
      </motion.div>}
      {panel==="replay"&&<motion.div key="replay" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}><ReplayPanel/></motion.div>}
      {panel==="settings"&&<motion.section className="settings glass" key="settings" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}}><h2>Local-first security</h2><p>Dwella’s interface is bundled inside the application. Hermes is only contacted through <code>127.0.0.1:8642</code>.</p><div><span><Dot on/>Renderer sandbox</span><span><Dot on/>Context isolation</span><span><Dot on/>Node disabled in UI</span><span><Dot on={status.hermesApiHealthy}/>Hermes localhost API</span></div></motion.section>}
      {panel==="backtest"&&<motion.div key="backtest" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}><BacktestPanel/></motion.div>}
      {panel==="autotrader"&&<motion.div key="autotrader" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0}}><AutoTraderPanel/></motion.div>}
      </AnimatePresence>
    </main>
  </div>
}

function BootScreen({done}:{done:()=>void}){
  const [step,setStep]=useState(0);
  useEffect(()=>{const timers=[setTimeout(()=>setStep(1),650),setTimeout(()=>setStep(2),1350),setTimeout(()=>setStep(3),2100),setTimeout(done,3100)];return()=>timers.forEach(clearTimeout)},[done]);
  return <motion.main className="boot-screen" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0,filter:"blur(18px)"}} transition={{duration:.55}}><motion.video className="boot-video" src={bootVideo} autoPlay muted loop playsInline initial={{opacity:0}} animate={{opacity:1}} transition={{duration:1}}/><motion.h1 initial={{opacity:0,y:14,filter:"blur(10px)"}} animate={{opacity:1,y:0,filter:"blur(0px)"}} transition={{delay:.45,duration:.8}}>Dwella</motion.h1><p>{["Initializing local workspace","Securing native runtime","Checking Hermes services","Ready"][step]}</p><div className="boot-progress"><motion.span initial={{width:"0%"}} animate={{width:`${[18,48,78,100][step]}%`}} transition={{duration:.5}}/></div><small>LOCAL TRADING OPERATING SYSTEM</small></motion.main>
}

function LoginScreen({onSuccess}:{onSuccess:()=>void}){
  const [hasLogin,setHasLogin]=useState(true),[password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{window.dwella.hasLocalLogin().then(setHasLogin)},[]);
  const submit=async()=>{setBusy(true);setError("");if(!hasLogin&&password!==confirm){setError("The passwords do not match.");setBusy(false);return}const result=hasLogin?await window.dwella.verifyLocalLogin(password):await window.dwella.createLocalLogin(password);setBusy(false);if(result.ok)onSuccess();else setError(result.message)};
  return <motion.main className="login-screen" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0,scale:1.02,filter:"blur(12px)"}}><section className="login-art"><motion.video className="login-video" src={loginVideo} autoPlay muted loop playsInline initial={{opacity:0,scale:1.08}} animate={{opacity:1,scale:1}} transition={{duration:1.6,ease:"easeOut"}}/><div className="login-top"><b>d</b><span><i/>Local environment</span></div><div className="login-rings"><i/><i/><i/><b>⌁</b></div><div className="login-copy"><small>YOUR STRATEGY.</small><h1>Trading while<br/>you live.</h1><p>Dwella keeps Hermes and your trading workspace close—without sending your desktop credentials to a website.</p></div><div className="login-terminal"><header><span><i/>Dwella Guard</span><b>OBSERVING</b></header><div><strong>NQ</strong><span><b>Long signal</b><small>2 contracts · stop attached</small></span><em>VALIDATED</em></div></div></section><section className="local-login"><header><span><i>d</i>dwella</span><small>LOCAL ACCESS</small></header><div className="login-form"><p>{hasLogin?"WELCOME BACK":"FIRST RUN"}</p><h2>{hasLogin?"Unlock Dwella":"Secure your workspace"}</h2><span>{hasLogin?"Enter your local password to open the dashboard.":"Create a password protected by macOS secure storage."}</span><label>Password<input autoFocus type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&hasLogin)submit()}} placeholder="Enter your password"/></label>{!hasLogin&&<label>Confirm password<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit()}} placeholder="Repeat your password"/></label>}{error&&<div className="login-error">{error}</div>}<button disabled={busy||password.length<6} onClick={submit}>{busy?"Unlocking…":hasLogin?"Open dashboard →":"Create local login →"}</button><small className="login-security">◇ Password encrypted locally · No Clerk · No cloud login</small></div><footer>© 2026 Dwella <span>macOS Desktop</span></footer></section></motion.main>
}

export default function App(){const[stage,setStage]=useState<"boot"|"login"|"app">("boot");return <><TitleBar/><AnimatePresence mode="wait">{stage==="boot"?<BootScreen key="boot" done={()=>setStage("login")}/>:stage==="login"?<LoginScreen key="login" onSuccess={()=>setStage("app")}/>:<DesktopDashboard key="app"/>}</AnimatePresence></>;}
