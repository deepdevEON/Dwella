/// <reference types="vite/client" />
export {};
declare global {
  interface Window { dwella: {
    platform:string; windowControls:{minimize:()=>Promise<void>;toggleMaximize:()=>Promise<void>;close:()=>Promise<void>;isMaximized:()=>Promise<boolean>;onMaxChanged:(cb:(isMax:boolean)=>void)=>()=>void}; hasLocalLogin:()=>Promise<boolean>; createLocalLogin:(password:string)=>Promise<ActionResult>; verifyLocalLogin:(password:string)=>Promise<ActionResult>; clearLocalLogin:()=>Promise<ActionResult>; getSystemStatus:()=>Promise<SystemStatus>; startHermes:()=>Promise<ActionResult>; stopHermes:()=>Promise<ActionResult>; askHermes:(input:string)=>Promise<ActionResult>; openExternal:(url:string)=>Promise<void>; getMarketQuotes:()=>Promise<MarketQuote[]>; getMarketBars:(s:string,tf:string,count?:number)=>Promise<BarsResult>; getAccount:()=>Promise<AccountSummary>; getPositions:()=>Promise<PositionsResult>;

    mt5: {
      testLogin: (profile:Mt5Profile)=>Promise<ActionResult>;
      login: (profile:Mt5Profile)=>Promise<ActionResult>;
      logout: ()=>Promise<ActionResult>;
      getProfiles: ()=>Promise<{ok:boolean;profiles:Mt5Profile[]}>;
      saveProfile: (profile:Mt5Profile)=>Promise<{ok:boolean;profiles:Mt5Profile[]}>;
      deleteProfile: (name:{name:string})=>Promise<{ok:boolean;profiles:Mt5Profile[]}>;
      getStatus: ()=>Promise<Mt5Status>;
      onStatus: (cb:(status:Mt5Status)=>void)=>()=>void;
    };

    buffy: {
      getHistory: () => Promise<BuffyMessage[]>;
      getSignals: () => Promise<BuffySignal[]>;
      onMessage: (cb: (msg: BuffyMessage) => void) => () => void;
      onSignal: (cb: (sig: BuffySignal) => void) => () => void;
    };
  }}
  interface SystemStatus { hermesInstalled:boolean; hermesRunning:boolean; hermesApiHealthy:boolean; zoConfigured?:boolean; platform:string; version?:string; }
  interface ActionResult { ok:boolean; message:string; output?:string; }
  interface MarketQuote { s:string; ok:boolean; price?:number; changePct?:number|null; src?:string; symbol?:string; time?:number; }
  interface MarketBar { t:number; o:number; h:number; l:number; c:number; v:number; }
  interface BarsResult { ok:boolean; symbol?:string; tf?:string; src?:string; bars?:MarketBar[]; }
  interface AccountSummary { ok:boolean; balance?:number; equity?:number; profit?:number; marginFree?:number; currency?:string; leverage?:number; server?:string; company?:string; login?:number; }
  interface Mt5Position { symbol:string; side:string; volume:number; entry:number; current:number; profit:number; }
  interface PositionsResult { ok:boolean; positions?:Mt5Position[]; }

  // ── MT5 Broker types ──────────────────────────────────────────────────
  interface Mt5Profile { name:string; login:string; password:string; server:string; isDefault?:boolean; }
  interface Mt5Status { ok?:boolean; connected?:boolean; broker?:string|null; server?:string|null; detail?:string; }

  // ── End MT5 Broker types ──────────────────────────────────────────────

  // ── Buffy types ──────────────────────────────────────────────────────
  interface BuffyMessage {
    id: string;
    sender: "Buffy" | "System";
    content: string;
    type: "analysis" | "signal" | "chat" | "alert";
    symbol?: string | null;
    timestamp: number;
  }
  interface BuffySignal {
    id: string;
    symbol: string;
    action: "buy" | "sell" | "close" | "hold";
    confidence: number;
    reasoning: string;
    entry: number | null;
    stop: number | null;
    target: number | null;
    timeframe: string;
    timestamp: number;
  }
  // ── End Buffy types ──────────────────────────────────────────────────

  // ── MT5 Replay types ──────────────────────────────────────────────────
  type ReplayTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
  type ReplaySpeed = 1 | 2 | 5 | 10 | 50;
  interface ReplayBar { time:number; open:number; high:number; low:number; close:number; volume:number; }
  interface ReplayState { bars:ReplayBar[]; currentIndex:number; isPlaying:boolean; speed:ReplaySpeed; startedAt:number|null; baseBarTime:number|null; selectedSymbol:string; selectedTimeframe:ReplayTimeframe; sourceKind:"synthetic"|"mt5"; }
  type OrderSide = "Long"|"Short";
  type OrderType = "Market"|"Limit"|"Stop";
  type OrderStatus = "Pending"|"Open"|"Closed"|"Cancelled";
  type CloseReason = "manual"|"stop"|"take-profit"|"expired";
  interface TradeOrder { id:string; symbol:string; side:OrderSide; type:OrderType; quantity:number; entryPrice:number; stopPrice?:number; limitPrice?:number; stopLoss?:number; takeProfit?:number; status:OrderStatus; exitPrice?:number; pnl?:number; pnlPercent?:number; openedAt:number; closedAt?:number; closedReason?:CloseReason; label?:string; }
  interface OrderOptions { stopLoss?:number; takeProfit?:number; }
  interface PracticeAccount { balance:number; equity:number; openPositions:TradeOrder[]; closedTrades:TradeOrder[]; pendingOrders:TradeOrder[]; totalPnl:number; winRate:number; tradeCount:number; }
  // ── End MT5 Replay types ──────────────────────────────────────────────
}
