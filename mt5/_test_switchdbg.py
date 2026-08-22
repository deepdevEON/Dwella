import sys, time, json
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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

def toggle():
    return s.tv_ui_eval(
        "(function(){var h=document.querySelector('.js-account-manager-header,[data-name=\"account-manager\"],[class*=\"accountManager\"]');"
        "if(!h)return {ok:false};h.click();return {ok:true};})()"
    )

print('header:', s.tv_account().get('name'), '| rows initially:', visible_names())
# toggle open, watch rows over time
toggle()
for i in range(6):
    time.sleep(0.5)
    print(f'  t+{(i+1)*0.5:.1f}s rows: {visible_names()}')
# toggle closed
toggle()
time.sleep(1.0)
print('after close rows:', visible_names())
