import sys, time
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tv_sidecar as s

t0 = time.time()
print('switching to itsgiddd...', flush=True)
ok = s.tv_switch_account('itsgiddd')
print(f'ok={ok} ({time.time()-t0:.1f}s)', flush=True)
live = s.tv_account()
print('header:', live.get('name'), 'bal:', live.get('balance'))
