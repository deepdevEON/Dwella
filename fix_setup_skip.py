#!/usr/bin/env python3
"""Skip setup screen when all components are already installed.
Only show setup if something is actually missing/broken.
"""

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# Replace the revealSplashLogin function to do a quick check first
old_reveal = """function revealSplashLogin(){
  var intro=document.getElementById('splashIntro');
  if(!intro||intro.classList.contains('is-revealed'))return;
  intro.classList.add('is-revealed');
  // Show ONLY the setup layer first — not the connect layer
  var setup=document.getElementById('splashSetup');
  if(setup)setup.classList.add('is-visible');
  var text=document.getElementById('introStatusText');
  if(text)text.textContent='Workspace ready';
  // Run component checks
  runSetupChecks();
}"""

new_reveal = """function revealSplashLogin(){
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

html = html.replace(old_reveal, new_reveal)

# Also reduce the intro animation delay since we're checking quickly
html = html.replace(
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?80:2400;",
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?80:1200;"
)

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Setup screen now skips when all components are installed')
