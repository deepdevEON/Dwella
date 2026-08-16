import sys, time, json
sys.path.insert(0, '/Users/gid/Documents/Flourish/mt5')
import tv_sidecar as s

def visible_names():
    r = s.tv_ui_eval(
        "(function(){var out=[];var els=document.querySelectorAll('[data-qa-id^=\"account-name-\"],[class*=\"itemAccountName\"]');"
        "for(var i=0;i<els.length;i++){var b=els[i].getBoundingClientRect();"
        "if(b.width>0&&b.height>0){var n=(els[i].textContent||'').trim();if(n&&out.indexOf(n)===-1)out.push(n);}}"
        "return JSON.stringify(out);})()"
    )
    try:
        v = r.get("result")
        return json.loads(v) if isinstance(v, str) else (v or [])
    except Exception:
        return []

print('start names:', visible_names(), flush=True)
r = s.tv_ui_eval(
    "(function(){"
    "var h=document.querySelector('.js-account-manager-header');"
    "if(!h)return {ok:false};"
    "var b=null;"
    "var all=h.querySelectorAll('button,[class*=\"dropdownButton\"],[class*=\"button\"]');"
    "for(var i=0;i<all.length;i++){var rr=all[i].getBoundingClientRect();"
    "if(rr.width>0&&rr.height>0){b=all[i];break;}}"
    "if(!b)return {ok:false};"
    "var rc=b.getBoundingClientRect();"
    "var cx=rc.left+rc.width/2,cy=rc.top+rc.height/2;"
    "var o={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0};"
    "b.dispatchEvent(new MouseEvent('mousedown',o));"
    "b.dispatchEvent(new MouseEvent('mouseup',o));"
    "b.dispatchEvent(new MouseEvent('click',o));"
    "return {ok:true,btn:rc.width+'x'+rc.height};})()"
)
print('toggle result:', r, flush=True)
for i in range(5):
    time.sleep(0.8)
    print(f'  t+{(i+1)*0.8:.1f}s names: {visible_names()}', flush=True)
