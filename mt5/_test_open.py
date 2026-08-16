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

print('names now:', visible_names())
# Click header once
r = s.tv_ui_eval("(function(){var h=document.querySelector('.js-account-manager-header');if(!h)return{ok:false};h.click();return{ok:true};})()")
print('click result:', r)
for i in range(5):
    time.sleep(0.8)
    print(f'  t+{(i+1)*0.8:.1f}s names: {visible_names()}')
