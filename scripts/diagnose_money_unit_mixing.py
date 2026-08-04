#!/usr/bin/env python3
"""Unit-mixing classifier, corrected.

The original classifier unioned units found only INSIDE aggregate bodies, so a
statement carrying SUM(cents_column) beside a plain yuan_column looked
single-unit. This version:

  1. unions the unit of EVERY money-column reference in a statement, wherever
     it sits — aggregate body, plain select item, arithmetic expression,
     predicate, INSERT column list;
  2. separates the two kinds of two-unit statement, because only one of them is
     a defect:
       DERIVED  — the statement builds a money value inside SQL (aggregate or
                  arithmetic) and a different unit is present in the same
                  statement. The derived scalar has no column left to identify
                  it, so a per-column boundary layer cannot convert it. This is
                  the shape of the five sites just fixed.
       CARRIED  — every money reference is a plain column. Column identity
                  survives, so a per-column boundary converts each correctly.
                  Reported for completeness, not as a defect.
  3. adds a HANDLER pass: units of SQL-derived money unioned across all the
     statements inside one route handler or function, because JavaScript then
     combines them (routes/finance.js:287-293 is that shape — three sums in six
     adjacent lines, one unit apart, subtracted downstream).

Static analysis only. Reads no database.
"""
import json, os, re, sys, collections

REPO = sys.argv[1] if len(sys.argv) > 1 else '/home/user/roots-v2'
plan = json.load(open(os.path.join(REPO, 'scripts/postgres-full-copy/plan.json'), encoding='utf-8'))

# This file deliberately contains verbatim copies of the pre-fix statements so
# the old and new forms can be run side by side. Scanning it would report the
# very statements it exists to retire.
SKIP = {'scripts/diagnose_money_unit_split.js'}

DECIDED_CENTS = {('expense_entries', 'amount')}   # survey §8 / decisions §24

def unit_of(table, col, cls, decided):
    if decided and (table, col) in DECIDED_CENTS: return 'cents'
    if cls == 'CENTS': return 'cents'
    if cls == 'NUM6': return 'yuan'
    if cls == 'INT' and col.endswith('_cents'): return 'cents'
    return None

def build(decided):
    per_table, by_name = collections.defaultdict(dict), collections.defaultdict(set)
    for t, spec in plan['tables'].items():
        for c in spec['cols']:
            u = unit_of(t, c['sq'], c['cls'], decided)
            if u:
                per_table[t][c['sq']] = u
                by_name[c['sq']].add((t, u))
    return per_table, by_name

FILES = []
for sub in ('routes', 'lib', 'middleware'):
    d = os.path.join(REPO, sub)
    if os.path.isdir(d):
        FILES += [f'{sub}/{f}' for f in sorted(os.listdir(d)) if f.endswith('.js')]
FILES += ['database.js', 'server.js']
FILES += ['scripts/' + f for f in sorted(os.listdir(os.path.join(REPO, 'scripts'))) if f.endswith('.js')]
FILES = [f for f in FILES if f not in SKIP]

LIT = re.compile(r"`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"", re.S)
ASSIGN = re.compile(r"(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(\+?=)\s*$")
DML = re.compile(r'\b(SELECT|INSERT|UPDATE|DELETE)\b', re.I)
HANDLER = re.compile(r'^\s*(?:router\.\w+\s*\(|(?:async\s+)?function\s+([\w$]+)|const\s+([\w$]+)\s*=\s*(?:async\s*)?\()', re.M)

def statements(path):
    src = open(os.path.join(REPO, path), encoding='utf-8', errors='replace').read()
    starts = [0] + [i + 1 for i, ch in enumerate(src) if ch == '\n']
    def lineno(off):
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= off: lo = mid
            else: hi = mid - 1
        return lo + 1
    # handler boundaries, for the handler-level pass
    bounds = [(m.start(), (m.group(1) or m.group(2) or 'route@' + str(lineno(m.start()))))
              for m in HANDLER.finditer(src)]
    def owner(off):
        name, at = '(file scope)', -1
        for s, n in bounds:
            if s <= off and s > at: at, name = s, n
        return f'{name}@{lineno(at) if at >= 0 else 0}'

    groups, solo = collections.OrderedDict(), []
    for m in LIT.finditer(src):
        raw, off = m.group(0)[1:-1], m.start()
        head = src[max(0, off - 120):off]
        am = ASSIGN.search(head)
        var, app = (am.group(1), am.group(2) == '+=') if am else (None, False)
        if var:
            if var in groups and app: groups[var][0] += '\n' + raw
            else: groups[var] = [raw, off]
        elif DML.search(raw):
            solo.append((lineno(off), owner(off), raw))
    out = list(solo)
    for var, (txt, off) in groups.items():
        full = txt
        for other, (otxt, _) in groups.items():
            if other != var: full = full.replace('${' + other + '}', otxt)
        if DML.search(full): out.append((lineno(off), owner(off), full))
    return out

FROMJOIN = re.compile(r'\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)\s*(?:AS\s+)?([A-Za-z_][\w]*)?', re.I)
KEYWORDS = {'select','from','join','where','and','or','on','as','left','inner','outer','group','by',
            'order','having','limit','offset','set','values','into','insert','update','delete','case',
            'when','then','else','end','not','null','is','in','like','desc','asc','distinct','coalesce',
            'sum','avg','count','min','max','round','cast','substr','trim','nullif','total','ifnull','abs'}
AGG = re.compile(r'\b(SUM|AVG|TOTAL)\s*\(', re.I)
REF = re.compile(r'\b(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)\b')
ARITH = re.compile(r'[*/]|(?<![(,\s])\s[-+]\s|\b[-+]\s*\w+\s*\*')

def agg_spans(sql):
    spans = []
    for m in AGG.finditer(sql):
        depth = 0
        for j in range(m.end() - 1, len(sql)):
            if sql[j] == '(': depth += 1
            elif sql[j] == ')':
                depth -= 1
                if depth == 0:
                    spans.append((m.end(), j)); break
    return spans

def item_spans(sql):
    """Top-level comma-separated select items, so 'is this reference part of an
    expression that produces a new value?' can be answered per item."""
    m = re.search(r'\bSELECT\b', sql, re.I)
    if not m: return []
    depth, start, out = 0, m.end(), []
    for j in range(m.end(), len(sql)):
        c = sql[j]
        if c == '(': depth += 1
        elif c == ')':
            if depth == 0: break
            depth -= 1
        elif c == ',' and depth == 0:
            out.append((start, j)); start = j + 1
        elif depth == 0 and sql[j:j + 6].upper() == ' FROM ':
            out.append((start, j)); start = None; break
    if start is not None: out.append((start, len(sql)))
    return out

def analyse(sql, per_table, by_name):
    aliases, tables = {}, set()
    for m in FROMJOIN.finditer(sql):
        t, a = m.group(1), m.group(2)
        if t.lower() in KEYWORDS: continue
        tables.add(t); aliases[t] = t
        if a and a.lower() not in KEYWORDS: aliases[a] = t
    for m in re.finditer(r'\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+([A-Za-z_][\w]*)', sql, re.I):
        tables.add(m.group(1)); aliases[m.group(1)] = m.group(1)

    aspans, ispans = agg_spans(sql), item_spans(sql)
    def derived(pos):
        if any(a <= pos <= b for a, b in aspans): return True
        for a, b in ispans:
            if a <= pos <= b:
                return bool(ARITH.search(sql[a:b]))
        return False

    refs = []
    for m in REF.finditer(sql):
        qual, col = m.group(1), m.group(2)
        if col.lower() in KEYWORDS: continue
        if qual:
            t = aliases.get(qual)
            if not t: continue
            u = per_table.get(t, {}).get(col)
            if u: refs.append((f'{t}.{col}', u, derived(m.start(2))))
        else:
            cands = {(t, u) for (t, u) in by_name.get(col, set()) if t in tables}
            units = {u for _, u in cands}
            if len(units) == 1:
                t = sorted(t for t, _ in cands)[0]
                refs.append((f'{t}.{col}', units.pop(), derived(m.start(2))))
    return refs

def run(decided, label):
    per_table, by_name = build(decided)
    derived_hits, carried_hits = [], []
    per_handler = collections.defaultdict(set)
    scanned = 0
    for path in FILES:
        for line, own, sql in statements(path):
            scanned += 1
            refs = analyse(sql, per_table, by_name)
            if not refs: continue
            units = {u for _, u, _ in refs}
            dunits = {u for _, u, d in refs if d}
            if dunits:
                per_handler[(path, own)] |= dunits
            if len(units) > 1:
                (derived_hits if dunits else carried_hits).append(
                    (path, line, sorted({(c, u, d) for c, u, d in refs}), sql))
    print(f'══ {label} ══')
    print(f'  statements scanned: {scanned}   files: {len(FILES)}')
    print(f'\n  DERIVED — a money value built inside SQL meets a different unit'
          f'  ->  {len(derived_hits)}')
    for p, l, cols, sql in derived_hits:
        print(f'\n   ── {p}:{l}')
        for c, u, d in cols: print(f'        {u:5s} {"derived" if d else "column ":8s} {c}')
        print('        SQL: ' + re.sub(r'\s+', ' ', sql).strip()[:300])
    print(f'\n  CARRIED — two units in one row, both as plain columns'
          f'  ->  {len(carried_hits)}')
    for p, l, cols, sql in carried_hits:
        print(f'   ── {p}:{l}   ' + ', '.join(f'{u}:{c}' for c, u, _ in cols))
    mixed_handlers = {k: v for k, v in per_handler.items() if len(v) > 1}
    print(f'\n  HANDLER — SQL-derived money of two units inside one handler/function'
          f'  ->  {len(mixed_handlers)}')
    for (p, own), units in sorted(mixed_handlers.items()):
        print(f'   ── {p}  {own}  units={sorted(units)}')
    print()

run(True,  'post-cutover units · expense_entries.amount = CENTS (the §24 decision)')
run(False, 'post-cutover units · expense_entries.amount = NUM6 yuan (plan.json as copied)')
