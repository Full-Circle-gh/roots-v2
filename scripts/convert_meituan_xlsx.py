#!/usr/bin/env python3
"""Convert a Meituan settlement XLSX into a JSON snapshot for the import script.

Usage:
    python3 scripts/convert_meituan_xlsx.py <path/to/file.xlsx> <store_nickname> <out.json>

Example:
    python3 scripts/convert_meituan_xlsx.py \\
        '/Users/ash/Desktop/GOVEGAN_哈素萌2026-03-01~2026-03-31订单-...xlsx' \\
        'Yuexiu 越秀' \\
        scripts/meituan_yuexiu_2026_03.json

Behavior:
    - Reads 订单明细 (order detail), 账单明细 (settlements), 账户余额流水 (balance).
    - Groups multi-row order_no rows into one record with aggregated fees.
    - Outputs one JSON file matching the schema the Node import script expects.
"""
import sys, openpyxl, json, re
from collections import defaultdict
from datetime import datetime

if len(sys.argv) != 4:
    print(__doc__)
    sys.exit(1)
PATH, NICKNAME, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

def num(v):
    if v is None or v == '' or v == '-': return 0.0
    s = str(v).strip()
    if s.endswith('%'): return float(s[:-1]) / 100.0
    try: return float(s)
    except: return 0.0

def to_iso(v):
    if v is None or v == '': return None
    if isinstance(v, datetime): return v.strftime('%Y-%m-%d %H:%M:%S')
    s = str(v).strip()
    return None if s in ('-', '') else s

wb = openpyxl.load_workbook(PATH, data_only=True)

# 订单明细 — group by order_no
ws = wb['订单明细']
rows = list(ws.iter_rows(values_only=True))
hdr = rows[0]
H = {h: i for i, h in enumerate(hdr)}
by_order = defaultdict(list)
for r in rows[1:]:
    onum = r[H['订单号']]
    if onum: by_order[onum].append(r)

store_ids   = set(r[H['门店id']] for r in rows[1:] if r[H['门店id']])
store_names = set(r[H['门店名称']] for r in rows[1:] if r[H['门店名称']])
store_id    = list(store_ids)[0] if store_ids else None
store_name  = list(store_names)[0] if store_names else None

orders = []
for onum, group in by_order.items():
    main_row = next((r for r in group if r[H['交易类型']] == '外卖订单'), group[0])
    order = {
        'source_order_no':  onum,
        'ordered_at':       to_iso(main_row[H['下单时间']]),
        'completed_at':     to_iso(main_row[H['完成时间']]),
        'refunded_at':      to_iso(main_row[H['退款时间']]),
        'status':           main_row[H['订单状态']],
        'delivery_method':  main_row[H['配送方式']],
        'customer_payment': main_row[H['用户支付方式']],
        'product_total':    num(main_row[H['商品总价']]),
        'package_fee':      num(main_row[H['打包费']]),
        'customer_paid':    num(main_row[H['用户线上支付金额']]),
        'customer_delivery_fee': num(main_row[H['用户支付配送费']]),
        'merchant_subsidy': num(main_row[H['商家对顾客的活动补贴']]),
        'platform_subsidy': num(main_row[H['美团活动补贴']]),
        'item_count':       int(num(main_row[H['商品数量']])),
        'commission':       num(main_row[H['佣金(实付)']]),
        'delivery_fee_paid':   0.0,
        'delivery_tip_paid':   0.0,
        'ad_spend':            0.0,
        'coupon_subsidy_paid': 0.0,
        'insurance_fee':       0.0,
        'partial_refund':      0.0,
        'net_to_merchant':     0.0,
    }
    for r in group:
        ttype = r[H['交易类型']]
        amount = num(r[H['商家应收款']])
        order['net_to_merchant'] += amount
        if ttype == '配送费用':           order['delivery_fee_paid']   += -amount
        elif ttype == '配送小费':          order['delivery_tip_paid']   += -amount
        elif ttype == '流量助手节省转入广告': order['ad_spend']            += -amount
        elif ttype in ('津贴联盟', '专属流量'): order['coupon_subsidy_paid'] += -amount
        elif ttype == '保险':              order['insurance_fee']       += -amount
        elif ttype == '订单部分退款':      order['partial_refund']      += -amount
        elif ttype == '配送订单取消扣款':  order['partial_refund']      += -amount
    order['gross_amount'] = order['product_total'] + order['package_fee']
    orders.append(order)

# 账单明细
ws = wb['账单明细']
brows = list(ws.iter_rows(values_only=True))
settlements = []
header_row_idx = None
for i, r in enumerate(brows):
    if r and r[0] == '结算id':
        header_row_idx = i; break
if header_row_idx is not None:
    bH = {h: i for i, h in enumerate(brows[header_row_idx])}
    for r in brows[header_row_idx+1:]:
        if not r or not r[bH['结算id']]: continue
        settlements.append({
            'settlement_id': r[bH['结算id']],
            'bill_date':     to_iso(r[bH['账单日期']]),
            'bill_amount':   num(r[bH['账单金额']]),
            'status':        r[bH['结算状态']],
            'period':        r[bH['归属账期']],
            'settled_on':    to_iso(r[bH['结算日期']]),
        })

# 账户余额流水
ws = wb['账户余额流水']
frows = list(ws.iter_rows(values_only=True))
fhdr = frows[0]
fH = {h: i for i, h in enumerate(fhdr)}
flow = []
for r in frows[1:]:
    if not r or not r[fH.get('交易号')]: continue
    flow.append({
        'txn_id':        r[fH['交易号']],
        'occurred_at':   to_iso(r[fH['日期']]),
        'type':          r[fH['类型']],
        'amount':        num(r[fH['金额(元)']]),
        'balance_after': num(r[fH['现有余额']]),
        'status':        r[fH['状态']],
    })

snapshot = {
    'store':       { 'source_store_id': str(store_id), 'name': store_name, 'nickname': NICKNAME },
    'orders':      orders,
    'settlements': settlements,
    'balance_flow': flow,
}
with open(OUT, 'w', encoding='utf8') as f:
    json.dump(snapshot, f, ensure_ascii=False, indent=2, default=str)

# Stats
gross = sum(o['gross_amount'] for o in orders)
net   = sum(o['net_to_merchant'] for o in orders)
print(f"Store: {store_name} (id={store_id}, nickname={NICKNAME})")
print(f"  Orders:        {len(orders)}")
print(f"  Gross:         ¥{gross:>10,.2f}")
print(f"  Net to merch:  ¥{net:>10,.2f}")
print(f"  Settlements:   {len(settlements)}")
print(f"  Balance flow:  {len(flow)}")
print(f"  → {OUT}")
