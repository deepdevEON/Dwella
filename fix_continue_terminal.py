#!/usr/bin/env python3
"""Fix Continue to Terminal so it opens the dashboard directly."""
from pathlib import Path

path = Path('/Users/gid/Documents/Flourish/dwella-terminal.html')
html = path.read_text(encoding='utf-8')

old = """function completeSetup(){
  _setupComplete=true;
  // Hide setup layer
  var setup=document.getElementById('splashSetup');
  if(setup){setup.classList.remove('is-visible');setup.style.opacity='0';setup.style.visibility='hidden';}
  // Show connect layer briefly then auto-connect
  var connect=document.getElementById('splashConnect');
  if(connect)connect.classList.add('is-visible');
  setTimeout(function(){connectTradingView();},800);
}"""

new = """function completeSetup(){
  // Components are verified. Continue must go directly to the dashboard;
  // do not expose the intermediate connection screen.
  _setupComplete=true;
  var btn=document.getElementById('setupContinueBtn');
  if(btn){btn.disabled=true;btn.textContent='Opening Terminal...';}
  var splash=document.getElementById('splash');
  if(splash){
    splash.style.display='none';
    splash.remove();
  }
  // Keep the live bridge connected in the background and start the normal
  // dashboard data refresh without blocking the user-facing terminal.
  fetch('http://127.0.0.1:18814/tv/launch',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:'{}'
  }).catch(function(){});
  if(typeof startDataPolling==='function')startDataPolling();
  if(typeof toast==='function')toast('Terminal ready. Live connection is running in the background.');
}"""

if old not in html:
    raise SystemExit('completeSetup block not found')

html = html.replace(old, new, 1)
path.write_text(html, encoding='utf-8')
print('Updated Continue to Terminal: direct dashboard launch')
