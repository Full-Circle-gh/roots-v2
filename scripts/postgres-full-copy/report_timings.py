#!/usr/bin/env python3
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
t = json.load(open(os.path.join(HERE, "timings.json"), encoding="utf-8"))
t.sort(key=lambda x: -(x["gen"] + x["load"]))
print("slowest 15 tables (gen + load):")
for x in t[:15]:
    tot = x["gen"] + x["load"]
    print("  {:>7.2f}s  gen={:>5.2f} load={:>6.2f}  {:<30} rows={:<7} {:>7.2f} MB".format(
        tot, x["gen"], x["load"], x["table"], x["rows"], x["bytes"] / 1e6))
print()
print("tables:", len(t))
print("rows:", sum(x["rows"] for x in t))
print("gen total: {:.1f}s   load total: {:.1f}s".format(
    sum(x["gen"] for x in t), sum(x["load"] for x in t)))
print("SQL generated: {:.1f} MB".format(sum(x["bytes"] for x in t) / 1e6))
print("largest single SQL file: {:.1f} MB".format(max(x["bytes"] for x in t) / 1e6))
