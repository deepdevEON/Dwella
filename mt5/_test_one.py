import sys, time
sys.path.insert(0, '/Users/gid/Documents/Flourish/mt5')
import tv_sidecar as s

t0 = time.time()
print('switching to itsgiddd...', flush=True)
ok = s.tv_switch_account('itsgiddd')
print(f'ok={ok} ({time.time()-t0:.1f}s)', flush=True)
live = s.tv_account()
print('header:', live.get('name'), 'bal:', live.get('balance'))
