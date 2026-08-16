#!/usr/bin/env python3
"""Add missing updateScannerUI function and ensure all buttons work."""

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# Add updateScannerUI function before the showView function
# Find the showView function and insert before it
show_view_pos = html.find('function showView(name){')
if show_view_pos > 0:
    # Go back to find a good insertion point (before the function)
    insert_pos = html.rfind('\n', 0, show_view_pos)
    
    scanner_ui_func = """

/* ── Scanner UI updater ── */
function updateScannerUI(d){
  if(!d)return;
  // Update arm/disarm button
  var armBtn=document.getElementById('armBtn');
  var disarmBtn=document.getElementById('disarmBtn');
  var scanStatus=document.getElementById('scanStatus');
  var scanStrategy=document.getElementById('scanStrategy');
  var scanDaily=document.getElementById('scanDaily');
  var scanTrades=document.getElementById('scanTrades');
  var scanLast=document.getElementById('scanLast');
  
  if(armBtn){
    if(d.armed){
      armBtn.style.display='none';
      if(disarmBtn)disarmBtn.style.display='inline-flex';
    }else{
      armBtn.style.display='inline-flex';
      if(disarmBtn)disarmBtn.style.display='none';
    }
  }
  
  if(scanStatus){
    scanStatus.textContent=d.armed?'ACTIVE':'PAUSED';
    scanStatus.style.color=d.armed?'var(--green2)':'var(--muted)';
  }
  if(scanStrategy)scanStrategy.textContent=d.strategy||'INVESTING_MASTERY_777';
  if(scanDaily)scanDaily.textContent=(d.daily_positions_taken||0)+'/'+(d.config&&d.config.daily_position_limit||5);
  if(scanTrades)scanTrades.textContent=(d.trade_log||[]).length;
  if(scanLast)scanLast.textContent=d.last_scan||'Waiting...';
  
  // Update signals list
  var sigList=document.getElementById('signalList');
  if(sigList){
    var signals=d.signals||[];
    if(signals.length===0){
      sigList.innerHTML='<div style="text-align:center;padding:20px;color:var(--muted2);font-size:12px">No active signals</div>';
    }else{
      var html='';
      signals.forEach(function(s){
        var dirClass=s.direction==='long'?'up':'dn';
        var dirIcon=s.direction==='long'?'▲':'▼';
        html+='<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;margin-bottom:4px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)">';
        html+='<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:'+(s.direction==='long'?'rgba(63,167,111,.15)':'rgba(224,82,82,.15)')+';color:'+(s.direction==='long'?'var(--green2)':'var(--red2)')+'">'+dirIcon+' '+s.direction.toUpperCase()+'</span>';
        html+='<span style="font-size:12px;font-weight:600;color:#f1eeff">'+s.symbol+'</span>';
        html+='<span style="font-size:10px;color:var(--gold);padding:2px 6px;border-radius:4px;background:rgba(212,175,55,.1)">'+s.strategy+'</span>';
        html+='<span style="margin-left:auto;font-size:10px;color:var(--muted)">Entry '+fmt(s.entry,2)+'</span>';
        html+='</div>';
      });
      sigList.innerHTML=html;
    }
  }
  
  // Update trades list
  var tradeList=document.getElementById('tradeList');
  if(tradeList){
    var trades=d.trade_log||[];
    if(trades.length===0){
      tradeList.innerHTML='<div style="text-align:center;padding:20px;color:var(--muted2);font-size:12px">No trades today</div>';
    }else{
      var html='';
      trades.slice(-5).reverse().forEach(function(t){
        var dirClass=t.direction==='long'?'up':'dn';
        html+='<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;margin-bottom:3px;background:rgba(255,255,255,.02);font-size:11px">';
        html+='<span style="color:'+(t.direction==='long'?'var(--green2)':'var(--red2)')+';font-weight:700">'+(t.direction==='long'?'▲':'▼')+' '+t.symbol+'</span>';
        html+='<span style="color:var(--gold)">'+t.strategy+'</span>';
        html+='<span style="margin-left:auto;color:var(--muted);font-size:10px">'+(t.time||'').slice(11,19)+'</span>';
        html+='</div>';
      });
      tradeList.innerHTML=html;
    }
  }
}

"""
    html = html[:insert_pos] + scanner_ui_func + html[insert_pos:]

# Also fix the arm/disarm button handlers
# Find and fix the arm button click handler
old_arm = "fetch('http://127.0.0.1:18814/scanner/arm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})"
if old_arm in html:
    new_arm = """fetch('http://127.0.0.1:18814/scanner/arm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();})
      .then(function(d){if(typeof toast==='function')toast(d.message||'Scanner armed');fetchScanner();})
      .catch(function(e){if(typeof toast==='function')toast('Failed to arm scanner');})"""
    html = html.replace(old_arm, new_arm, 1)

old_disarm = "fetch('http://127.0.0.1:18814/scanner/disarm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})"
if old_disarm in html:
    new_disarm = """fetch('http://127.0.0.1:18814/scanner/disarm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();})
      .then(function(d){if(typeof toast==='function')toast(d.message||'Scanner disarmed');fetchScanner();})
      .catch(function(e){if(typeof toast==='function')toast('Failed to disarm scanner');})"""
    html = html.replace(old_disarm, new_disarm, 1)

# Add fetchScanner function if not present
if 'function fetchScanner()' not in html:
    fetch_scanner_func = """
/* ── Fetch scanner status ── */
function fetchScanner(){
  fetch('http://127.0.0.1:18814/scanner')
    .then(function(r){return r.json();})
    .then(function(d){updateScannerUI(d);})
    .catch(function(){});
}
"""
    # Insert before updateScannerUI
    insert_before = html.find('function updateScannerUI(d){')
    if insert_before > 0:
        insert_pos = html.rfind('\n', 0, insert_before)
        html = html[:insert_pos] + fetch_scanner_func + html[insert_pos:]

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Added: updateScannerUI, fetchScanner, fixed arm/disarm handlers')
