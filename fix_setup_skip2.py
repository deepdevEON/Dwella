#!/usr/bin/env python3
"""Simple fix: when all components are installed, skip the entire splash
and go straight to the main app.
"""

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# Replace the revealSplashLogin function
old_reveal = """function revealSplashLogin(){
  var intro=document.getElementById('splashIntro');
  if(!intro||intro.classList.contains('is-revealed'))return;
  intro.classList.add('is-revealed');
  var text=document.getElementById('introStatusText');
  if(text)text.textContent='Checking components...';
  
  // Quick check: if all components already pass, skip setup entirely
  fetch('http://127.0.0.1:18814/tv/check')
    .then(function(r){return r.json();})
    .then(function(d){
      var allOk = d.tv_installed && d.cdp_ok && d.node_ok && d.mcp_ok;
      if(allOk){
        // All components installed — skip setup, go straight to connect
        if(text)text.textContent='All components ready';
        _setupComplete=true;
        var connect=document.getElementById('splashConnect');
        if(connect)connect.classList.add('is-visible');
        setTimeout(function(){connectTradingView();},600);
      } else {
        // Something missing — show setup screen
        var setup=document.getElementById('splashSetup');
        if(setup)setup.classList.add('is-visible');
        if(text)text.textContent='Workspace ready';
        runSetupChecks();
      }
    })
    .catch(function(){
      // Can't reach sidecar — show setup screen
      var setup=document.getElementById('splashSetup');
      if(setup)setup.classList.add('is-visible');
      if(text)text.textContent='Workspace ready';
      runSetupChecks();
    });
}"""

new_reveal = """function revealSplashLogin(){
  var intro=document.getElementById('splashIntro');
  if(!intro||intro.classList.contains('is-revealed'))return;
  intro.classList.add('is-revealed');
  var text=document.getElementById('introStatusText');
  if(text)text.textContent='Checking components...';
  
  // Quick check: if all components already pass, skip EVERYTHING
  fetch('http://127.0.0.1:18814/tv/check')
    .then(function(r){return r.json();})
    .then(function(d){
      var allOk = d.tv_installed && d.cdp_ok && d.node_ok && d.mcp_ok;
      if(allOk){
        // All components installed — remove splash entirely, show app
        if(text)text.textContent='All ready';
        var splash=document.getElementById('splash');
        if(splash){
          splash.classList.add('fade-out');
          setTimeout(function(){splash.remove();},600);
        }
        // Auto-connect in background
        fetch('http://127.0.0.1:18814/tv/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(function(){});
        // Start polling for data
        setTimeout(function(){startDataPolling();},1000);
      } else {
        // Something missing — show setup screen
        var setup=document.getElementById('splashSetup');
        if(setup)setup.classList.add('is-visible');
        if(text)text.textContent='Workspace ready';
        runSetupChecks();
      }
    })
    .catch(function(){
      // Can't reach sidecar — show setup screen
      var setup=document.getElementById('splashSetup');
      if(setup)setup.classList.add('is-visible');
      if(text)text.textContent='Workspace ready';
      runSetupChecks();
    });
}

// Data polling function — fetches account, positions, ticks continuously
function startDataPolling(){
  function pollAll(){
    // Fetch account data
    fetch('http://127.0.0.1:18814/account').then(function(r){return r.json();}).then(function(d){
      if(!d.account)return;
      var a=d.account;
      if(a.balance>0){var hb=document.getElementById('hdrBalance');if(hb)hb.textContent=fmtMoney(a.balance);}
      if(a.equity>0){var he=document.getElementById('hdrEquity');if(he)he.textContent=fmtMoney(a.equity);}
      var hp=document.getElementById('hdrPnl');
      if(hp){var hrp=parseSignedPnl(a.realized_pnl!=null?a.realized_pnl:a.profit);if(hrp==null)hrp=0;hp.textContent=(hrp>=0?'+':'\\u2212')+fmtMoney(Math.abs(hrp));hp.className='ha-val ha-pnl '+(hrp>=0?'up':'dn');}
      var setAcctEl=document.getElementById('setAcct');if(setAcctEl)setAcctEl.textContent=a.name;
      if(a.balance>0){var sb=document.getElementById('sideBalance');if(sb)sb.textContent=fmtMoney(a.balance);}
      if(a.equity>0){var se=document.getElementById('sideEquity');if(se)se.textContent=fmtMoney(a.equity!=null?a.equity:a.balance);}
      var sa=document.getElementById('sideAcctName');if(sa)sa.textContent=a.name;
      var sp=document.getElementById('sidePnl');
      if(sp){sp.textContent=(hrp>=0?'+ ':'\\u2212 ')+fmtMoney(Math.abs(hrp))+' \\u00b7 realized';sp.className='sub '+(hrp>=0?'up':'dn');}
      var su=document.getElementById('sideUnrealized');
      if(su){var upv=parseSignedPnl(a.unrealized_pnl);if(upv==null)upv=0;su.textContent=(upv>=0?'+ ':'\\u2212 ')+fmtMoney(Math.abs(upv));su.className='v '+(upv>=0?'up':'dn');}
    }).catch(function(){});
    // Fetch positions
    fetch('http://127.0.0.1:18814/positions').then(function(r){return r.json();}).then(function(d){
      var positions=Array.isArray(d.positions)?d.positions:[];
      chart.positions=positions;
      var posCountTab=document.getElementById('posCountTab');if(posCountTab)posCountTab.textContent=positions.length;
      var posSub=document.getElementById('posSub');if(posSub)posSub.textContent=positions.length+' open \\u00b7 live account data';
    }).catch(function(){});
    // Fetch scanner
    fetch('http://127.0.0.1:18814/scanner').then(function(r){return r.json();}).then(function(d){
      updateScannerUI(d);
    }).catch(function(){});
  }
  pollAll();
  setInterval(pollAll,5000);
  // Fetch chart data
  fetchChartCandles();
  setInterval(fetchChartCandles,5000);
  renderMarketCards();
  fetchTickData();
  setInterval(fetchTickData,3000);
}"""

html = html.replace(old_reveal, new_reveal)

# Also reduce the intro delay
html = html.replace(
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?80:1200;",
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?80:800;"
)

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Setup skip: now removes splash entirely when all components OK')
