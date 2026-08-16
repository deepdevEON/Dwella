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
        if isinstance(v, str):
            return json.loads(v)
        return v or []
    except Exception:
        return []

print('dropdown rows now:', visible_names())
print('header now:', s.tv_account().get('name'))

# Manually click itsgiddd row via raw JS and watch the result
js = """(function() {
  var target = 'itsgiddd';
  function clickableRow(el) {
    var node = el;
    for (var k = 0; k < 5 && node; k++) {
      var cls = (node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').toString();
      if (cls.indexOf('button') !== -1 || node.getAttribute('role') === 'button' || node.tagName === 'BUTTON') return node;
      node = node.parentElement;
    }
    return el.closest('[class*="button"]') || el;
  }
  var els = document.querySelectorAll('[data-qa-id^="account-name-"],[class*="itemAccountName"],[class*="accountName"],[class*="itemTitle"]');
  var found = [];
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').trim();
    var r = els[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && t.toLowerCase().indexOf(target.toLowerCase()) !== -1) {
      var row = clickableRow(els[i]);
      found.push({span: t.slice(0,20), spanCls: (els[i].className||'').toString().slice(0,40), rowCls: (row.className||'').toString().slice(0,50), rowTag: row.tagName});
      row.click();
      return {ok: true, found: found};
    }
  }
  return {ok: false, found: found, visibleRows: document.querySelectorAll('[data-qa-id^="account-name-"]').length};
})()"""
print('click result:', s.tv_ui_eval(js))
time.sleep(2.5)
print('header after click:', s.tv_account().get('name'))
