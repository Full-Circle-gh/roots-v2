#!/usr/bin/env python3
"""
The three targeted checks the round-trip pass does not cover on its own:

  1. every foreign key resolves in Postgres (asked of the database, not inferred)
  2. Chinese text survived with matching character counts
  3. the wide base64 columns arrived at full length, by SHA-256 of the bytes
"""
import sqlite3, json, os, subprocess, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
WIDE = [tuple(x) for x in json.load(open(os.path.join(HERE, "wide_cols.json"), encoding="utf-8"))]
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"


def psql(sql, soft=False):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        if soft:
            err = p.stderr.strip().splitlines()
            return None, (err[0] if err else "failed")
        raise SystemExit(f"psql failed:\n{p.stderr}")
    return (p.stdout.strip(), None) if soft else p.stdout.strip()


print("=== 1. foreign keys ===")
# Ask Postgres to re-check every FK constraint against the loaded rows. This is
# the database validating its own constraints, not a query I wrote agreeing with
# a query I wrote.
names = psql("select conrelid::regclass::text || '|' || conname from pg_constraint c "
             "join pg_namespace n on n.oid=c.connamespace "
             "where n.nspname='public' and c.contype='f' order by 1;")
fks = [l.split("|") for l in names.splitlines() if l]
print(f"  foreign key constraints defined: {len(fks)}")
bad = []
for tbl, con in fks:
    _, err = psql(f'ALTER TABLE "{tbl}" VALIDATE CONSTRAINT "{con}";', soft=True)
    if err:
        bad.append(f"{tbl}.{con}: {err}")
print(f"  validated OK: {len(fks)-len(bad)}   failures: {len(bad)}")
for b in bad:
    print("   ", b)
# and confirm none are sitting in a NOT VALID state
nv = psql("select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace "
          "where n.nspname='public' and c.contype='f' and not c.convalidated;")
print(f"  constraints still marked NOT VALID: {nv}")

print("\n=== 2. Chinese text ===")
con = sqlite3.connect(SRC, uri=True)
tot_sq = tot_pg = 0
rows_checked = 0
mismatch = []
for st, spec in sorted(plan["tables"].items()):
    if spec["rows"] == 0:
        continue
    pt = spec["pg"]
    for c in spec["cols"]:
        if c["cls"] != "TEXT" or (st, c["sq"]) in WIDE:
            continue
        # count CJK characters across the whole column, both sides
        n_sq = con.execute(
            f'SELECT COUNT(*) FROM "{st}" WHERE "{c["sq"]}" GLOB \'*[一-鿿]*\'').fetchone()[0]
        if not n_sq:
            continue
        # total CJK codepoints in the column
        sq_chars = 0
        for (v,) in con.execute(f'SELECT "{c["sq"]}" FROM "{st}" WHERE "{c["sq"]}" GLOB \'*[一-鿿]*\''):
            sq_chars += sum(1 for ch in v if "一" <= ch <= "鿿")
        pg_chars = int(psql(
            f"""select coalesce(sum(length(regexp_replace("{c['pg']}", '[^一-鿿]', '', 'g'))),0)
                from "{pt}" where "{c['pg']}" ~ '[一-鿿]';"""))
        rows_checked += n_sq
        tot_sq += sq_chars
        tot_pg += pg_chars
        if sq_chars != pg_chars:
            mismatch.append((st, c["sq"], sq_chars, pg_chars))
print(f"  columns holding Chinese compared; rows containing CJK: {rows_checked}")
print(f"  CJK characters — sqlite: {tot_sq}   postgres: {tot_pg}")
print(f"  columns with a character-count mismatch: {len(mismatch)}")
for m in mismatch:
    print("   ", m)

print("\n=== 3. wide base64 columns, SHA-256 of the UTF-8 bytes ===")
allok = True
for st, col in WIDE:
    spec = plan["tables"][st]
    pt = spec["pg"]
    pgcol = next(c["pg"] for c in spec["cols"] if c["sq"] == col)
    pk = "id" if any(c["sq"] == "id" for c in spec["cols"]) else spec["cols"][0]["sq"]
    pgpk = next(c["pg"] for c in spec["cols"] if c["sq"] == pk)
    pg = {}
    for line in psql(f"""select "{pgpk}"::text || '|' || length("{pgcol}")::text || '|' ||
                         encode(sha256(convert_to("{pgcol}",'UTF8')),'hex')
                         from "{pt}" where "{pgcol}" is not null;""").splitlines():
        k, ln, h = line.split("|")
        pg[k] = (int(ln), h)
    sq = {}
    biggest = 0
    for k, v in con.execute(f'SELECT "{pk}", "{col}" FROM "{st}" WHERE "{col}" IS NOT NULL'):
        b = str(v).encode("utf-8")
        sq[str(k)] = (len(str(v)), hashlib.sha256(b).hexdigest())
        biggest = max(biggest, len(str(v)))
    same = sum(1 for k in sq if pg.get(k) == sq[k])
    bad = [k for k in sq if pg.get(k) != sq[k]]
    status = "OK" if not bad and len(pg) == len(sq) else f"*** {len(bad)} MISMATCH ***"
    allok &= not bad and len(pg) == len(sq)
    print(f"  {st}.{col:<22} values={len(sq):<6} sha256 match={same:<6} "
          f"widest={biggest:>9} chars  {status}")
    for k in bad[:5]:
        print(f"      pk={k} sqlite={sq[k]} postgres={pg.get(k)}")
print(f"\n  all wide columns byte-identical: {allok}")
con.close()
