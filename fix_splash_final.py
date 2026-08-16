#!/usr/bin/env python3
"""Bulletproof fix: immediately remove splash when components are installed.
No animations, no delays, no intermediate screens.
"""

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# Replace the entire revealSplashLogin function with a bulletproof version
old_reveal = """function revealSplashLogin(){
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
}"""

new_reveal = """function revealSplashLogin(){
  // Quick check: if all components already pass, remove splash IMMEDIATELY
  fetch('http://127.0.0.1:18814/tv/check')
    .then(function(r){return r.json();})
    .then(function(d){
      var allOk = d.tv_installed && d.cdp_ok && d.node_ok && d.mcp_ok;
      if(allOk){
        // All components installed — REMOVE SPLASH NOW, no animation
        var splash=document.getElementById('splash');
        if(splash){
          splash.style.display='none';
          splash.remove();
        }
        // Auto-connect in background
        fetch('http://127.0.0.1:18814/tv/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(function(){});
        // Start polling for data immediately
        startDataPolling();
      } else {
        // Something missing — show intro then setup
        var intro=document.getElementById('splashIntro');
        if(intro)intro.classList.add('is-revealed');
        var setup=document.getElementById('splashSetup');
        if(setup)setup.classList.add('is-visible');
        var text=document.getElementById('introStatusText');
        if(text)text.textContent='Workspace ready';
        runSetupChecks();
      }
    })
    .catch(function(){
      // Can't reach sidecar — show setup screen
      var intro=document.getElementById('splashIntro');
      if(intro)intro.classList.add('is-revealed');
      var setup=document.getElementById('splashSetup');
      if(setup)setup.classList.add('is-visible');
      var text=document.getElementById('introStatusText');
      if(text)text.textContent='Workspace ready';
      runSetupChecks();
    });
}"""

html = html.replace(old_reveal, new_reveal)

# Also reduce the intro delay to 500ms
html = html.replace(
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?80:800;",
    "var introRevealDelay=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?50:500;"
)

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Splash now REMOVED IMMEDIATELY when all components installed')
print('No animation, no delay, no intermediate screens')
