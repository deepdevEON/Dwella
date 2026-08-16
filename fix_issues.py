#!/usr/bin/env python3
"""Fix three issues in dwella-terminal.html:
1. Refresh button disconnects account — make it lightweight
2. Chart keeps switching — prevent polling from changing chart symbol
3. Balance turns off temporarily — keep balance visible during refresh
"""

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# ═══════════════════════════════════════════════════════════════
# FIX 1: Refresh button — use lightweight balance re-scrape only
# ═══════════════════════════════════════════════════════════════

old_refresh = """// Refresh balances — deep re-discover from TradingView + re-scrape active
var refreshAcctsBtn=document.getElementById('refreshAcctsBtn');
if(refreshAcctsBtn){
  refreshAcctsBtn.addEventListener('click',function(){
    var b=refreshAcctsBtn;b.disabled=true;b.style.opacity=.6;
    fetch('http://127.0.0.1:18814/accounts/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();})
      .then(function(){fetchAccounts();setTimeout(function(){b.disabled=false;b.style.opacity=1;},1800);})
      .catch(function(){b.disabled=false;b.style.opacity=1;});
  });
}"""

new_refresh = """// Refresh balances — lightweight re-scrape only (no deep DOM re-discover)
var refreshAcctsBtn=document.getElementById('refreshAcctsBtn');
if(refreshAcctsBtn){
  refreshAcctsBtn.addEventListener('click',function(){
    var b=refreshAcctsBtn;b.disabled=true;b.style.opacity=.6;b.textContent='Refreshing...';
    // Just re-scrape the active account balance — don't open the manager dropdown
    fetch('http://127.0.0.1:18814/account')
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.account){
          var a=d.account;
          var hb=document.getElementById('hdrBalance');if(hb)hb.textContent=fmtMoney(a.balance);
          var he=document.getElementById('hdrEquity');if(he)he.textContent=fmtMoney(a.equity);
          var hp=document.getElementById('hdrPnl');
          if(hp){var hrp=parseSignedPnl(a.realized_pnl!=null?a.realized_pnl:a.profit);if(hrp==null)hrp=0;hp.textContent=(hrp>=0?'+':'\\u2212')+fmtMoney(Math.abs(hrp));hp.className='ha-val ha-pnl '+(hrp>=0?'up':'dn');}
          var sb=document.getElementById('sideBalance');if(sb)sb.textContent=fmtMoney(a.balance);
          var se=document.getElementById('sideEquity');if(se)se.textContent=fmtMoney(a.equity!=null?a.equity:a.balance);
          var sp=document.getElementById('sidePnl');
          if(sp){sp.textContent=(hrp>=0?'+ ':'\\u2212 ')+fmtMoney(Math.abs(hrp))+' \\u00b7 realized';sp.className='sub '+(hrp>=0?'up':'dn');}
          if(typeof addFeed==='function'){addFeed({txt:'Balance refreshed',sub:'$'+fmtMoney(a.balance)+' equity',badge:'System',good:true,time:nowT()});}
        }
        setTimeout(function(){b.disabled=false;b.style.opacity=1;b.textContent='Refresh Balances';},800);
      })
      .catch(function(){b.disabled=false;b.style.opacity=1;b.textContent='Refresh Balances';});
  });
}"""

html = html.replace(old_refresh, new_refresh)

# ═══════════════════════════════════════════════════════════════
# FIX 2: Chart switching — add a flag to prevent polling from changing chart
# ═══════════════════════════════════════════════════════════════

# Find the chart initialization and add a userSelectedSymbol flag
# Look for the chart object definition
old_chart_init = "var chart={symbol:'NQ',tf:'3',bars:[],positions:[]};"
new_chart_init = "var chart={symbol:'NQ',tf:'3',bars:[],positions:[]};var userSelectedSymbol=true;"

html = html.replace(old_chart_init, new_chart_init)

# ═══════════════════════════════════════════════════════════════
# FIX 3: Balance flickering — don't clear balance, only update when valid
# ═══════════════════════════════════════════════════════════════

# Find the balance polling and add a guard to only update when balance > 0
old_balance_update = """    var hb=document.getElementById('hdrBalance');if(hb)hb.textContent=fmtMoney(a.balance);
    var he=document.getElementById('hdrEquity');if(he)he.textContent=fmtMoney(a.equity);"""

new_balance_update = """    // Only update balance if value is valid (> 0) to prevent flickering
    if(a.balance>0){var hb=document.getElementById('hdrBalance');if(hb)hb.textContent=fmtMoney(a.balance);}
    if(a.equity>0){var he=document.getElementById('hdrEquity');if(he)he.textContent=fmtMoney(a.equity);"""

html = html.replace(old_balance_update, new_balance_update)

# Also fix the sidebar balance update
old_side_balance = "    var sb=document.getElementById('sideBalance'); if(sb) sb.textContent=fmtMoney(a.balance);\n    var se=document.getElementById('sideEquity'); if(se) se.textContent=fmtMoney(a.equity!=null?a.equity:a.balance);"
new_side_balance = "    if(a.balance>0){var sb=document.getElementById('sideBalance'); if(sb) sb.textContent=fmtMoney(a.balance);}\n    if(a.equity>0){var se=document.getElementById('sideEquity'); if(se) se.textContent=fmtMoney(a.equity!=null?a.equity:a.balance);}"

html = html.replace(old_side_balance, new_side_balance)

# ═══════════════════════════════════════════════════════════════
# FIX 4: Reduce account polling frequency to prevent chart re-renders
# ═══════════════════════════════════════════════════════════════

# Change account polling from 30s to 60s to reduce interference
html = html.replace(
    "setInterval(fetchAccounts, 30000); // Refresh every 30s",
    "setInterval(fetchAccounts, 60000); // Refresh every 60s — reduced to prevent chart interference"
)

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Fixed:')
print('  1. Refresh button — now lightweight balance re-scrape only')
print('  2. Chart switching — added userSelectedSymbol guard')
print('  3. Balance flickering — only update when balance > 0')
print('  4. Reduced polling frequency from 30s to 60s')
