import sys
sys.path.insert(0, '/Users/gid/Documents/Flourish/mt5')
import tv_sidecar as s

print('=== switch to The Leap ===')
for i in range(3):
    ok = s.tv_switch_account('The Leap')
    live = s.tv_account()
    print(f'attempt {i+1}: switch_ok={ok} header={live.get("name")} bal={live.get("balance")}')

print('=== switch back to itsgiddd ===')
for i in range(3):
    ok = s.tv_switch_account('itsgiddd')
    live = s.tv_account()
    print(f'attempt {i+1}: switch_ok={ok} header={live.get("name")} bal={live.get("balance")}')
