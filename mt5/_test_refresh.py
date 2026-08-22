import sys, time, json
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tv_sidecar as s

# Build a minimal state like main() does
state = s.State()
print('state loaded. active_id:', state.active_account_id)
for a in state.accounts:
    print('  acct:', a['name'], 'bal=%s' % a['balance'], 'verified=%s' % a['verified'], 'active=%s' % a['active'])

print('\n=== step 1: sync_tv_accounts(deep=True) ===')
s.sync_tv_accounts(state, deep=True)
for a in state.accounts:
    print('  after sync:', a['name'], 'bal=%s' % a['balance'], 'verified=%s' % a['verified'], 'active=%s' % a['active'])
print('  active_id:', state.active_account_id)

print('\n=== step 2: switch each non-active ===')
for a in list(state.accounts):
    name = a['name']
    active_id = state.active_account_id
    active_name = next((x.get('name','') for x in state.accounts if x.get('id') == active_id), '')
    if not name or name.lower() == (active_name or '').lower():
        print('  skip (active):', name)
        continue
    t0 = time.time()
    switched = s.tv_switch_account(name)
    live = s.tv_account()
    print(f'  switch to {name}: ok={switched} ({time.time()-t0:.1f}s) header={live.get("name")} bal={live.get("balance")}')
    if switched and live and live.get('balance'):
        state.update_account_balance(a['id'], float(live['balance']), float(live.get('equity') or live['balance']), float(live.get('realized_pnl') or 0))
        print('    -> updated balance for', name, 'to', live['balance'])

print('\n=== step 3: restore active ===')
active_id = state.active_account_id
active_name = next((x.get('name','') for x in state.accounts if x.get('id') == active_id), '')
print('  restoring to:', active_name)
restored = s.tv_switch_account(active_name) if active_name else False
live = s.tv_account()
print('  restored:', restored, 'header:', live.get('name'), 'bal:', live.get('balance'))
if restored and live and live.get('balance'):
    with state.lock:
        for a in state.accounts:
            if a['id'] == active_id:
                a['balance'] = float(live.get('balance', a.get('balance', 0)))
                a['equity'] = float(live.get('equity') or live.get('balance') or a.get('equity', 0))
                a['pnl'] = float(live.get('realized_pnl') or 0)
                a['verified'] = True
                break
        state.active_account_id = active_id
        for a in state.accounts:
            a['active'] = (a['id'] == active_id)
        state._save_accounts()

print('\n=== FINAL ===')
for a in state.accounts:
    print(' ', a['name'], 'bal=%s' % a['balance'], 'verified=%s' % a['verified'], 'active=%s' % a['active'])
print('active_id:', state.active_account_id)
