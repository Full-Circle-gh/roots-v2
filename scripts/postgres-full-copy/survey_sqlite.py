#!/usr/bin/env python3
"""Read-only survey of the live SQLite database. Writes JSON to stdout."""
import sqlite3, json, sys

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
con = sqlite3.connect(SRC, uri=True)
con.row_factory = sqlite3.Row

# Prove read-only.
try:
    con.execute("CREATE TABLE __probe__ (x)")
    print(json.dumps({"fatal": "SQLite connection accepted a write"}))
    sys.exit(2)
except sqlite3.OperationalError:
    pass

out = {"tables": {}}
names = [r[0] for r in con.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
for t in names:
    n = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    cols = []
    for c in con.execute(f'PRAGMA table_info("{t}")'):
        cols.append({"name": c["name"], "type": c["type"], "notnull": c["notnull"],
                     "dflt": c["dflt_value"], "pk": c["pk"]})
    fks = []
    for f in con.execute(f'PRAGMA foreign_key_list("{t}")'):
        fks.append({"table": f["table"], "from": f["from"], "to": f["to"]})
    sql = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
    out["tables"][t] = {"rows": n, "cols": cols, "fks": fks,
                        "autoincrement": "AUTOINCREMENT" in (sql or "").upper()}
print(json.dumps(out))
con.close()
