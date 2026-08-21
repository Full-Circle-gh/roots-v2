#!/usr/bin/env python3
"""
The three decided value overrides (decisions 4, 6 and 7).

One module, imported by both the generator and the verifier, so the copied value
and the expected value can never drift apart. Each rule counts the rows it
touches, and the run asserts that count against the rows the rule's OWN
CONDITION matches in the source -- re-derived every run, never stored. So a
rule that catches more rows than it should, or fewer, is caught rather than
trusted, and the assertion cannot expire.
"""
import re, sqlite3

DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"

hits = {"voucher_eod": 0, "packaging_null": 0, "updated_by_null": 0}

# EACH RULE'S OWN CONDITION, EXPRESSED AS SQL AGAINST THE SOURCE.
#
# This replaces EXPECTED = {"voucher_eod": 1, "packaging_null": 1,
# "updated_by_null": 4} -- three counts measured once on 2026-08-03 and then
# asserted for equality against live data ever since. On 2026-08-21
# `updated_by_null` fired 2 against an expected 4, because two
# storefront_config rows had been edited by a real user in the meantime and no
# longer carried a text sentinel. The rule was right; the constant had an
# expiry date nobody wrote down, and run.py aborted a CLEAN COPY over it.
#
# Each condition below mirrors the isinstance/regex test in override()
# exactly, so the assertion becomes "the rule fired on every row it should
# have" rather than "the rule fired N times". SQLite typeof() returns the
# storage class, which is what isinstance() sees through the driver:
# TEXT -> str, BLOB -> bytes.
PREDICATE = {
    # isinstance(v, str) and DATE_ONLY.match(v)
    "voucher_eod": ("retail_vouchers",
                    "typeof(expires_at) = 'text' AND expires_at GLOB "
                    "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'"),
    # isinstance(v, (str, bytes))
    "packaging_null": ("recipe_cost_data",
                       "typeof(packaging_type_id) IN ('text', 'blob')"),
    # isinstance(v, (str, bytes))
    "updated_by_null": ("storefront_config",
                        "typeof(updated_by) IN ('text', 'blob')"),
}


def override(st, col, v):
    """Return (rule_name, replacement_value) or None.

    The replacement is expressed as the SQLite-side value the normal renderer
    would have produced, so both generation and verification run through the
    same code path afterwards.
    """
    # Decision 4 — retail_vouchers id 1 expires end of day China time, matching
    # every other dated voucher (23:59:59 CST == 15:59:59Z).
    if st == "retail_vouchers" and col == "expires_at":
        if isinstance(v, str) and DATE_ONLY.match(v):
            hits["voucher_eod"] += 1
            return ("voucher_eod", v + "T15:59:59Z")

    # Decision 6 — the reference pt1778315688913 does not exist and never did.
    if st == "recipe_cost_data" and col == "packaging_type_id":
        if isinstance(v, (str, bytes)):
            hits["packaging_null"] += 1
            return ("packaging_null", None)

    # Decision 7 — 'setup-script' and 'claude-golive' are not user ids.
    if st == "storefront_config" and col == "updated_by":
        if isinstance(v, (str, bytes)):
            hits["updated_by_null"] += 1
            return ("updated_by_null", None)

    return None


def expected():
    """Ask the SOURCE how many rows each rule's own condition matches.

    Read-only, and proven so on connect. Raises rather than returning a number
    it could not compute: a rule whose expectation cannot be read is
    unverifiable, and unverifiable must not read as agreement.
    """
    con = sqlite3.connect(SRC, uri=True)
    try:
        con.execute("CREATE TABLE __overrides_probe__ (x)")
        raise SystemExit("FATAL: SQLite accepted a write in overrides.expected()")
    except sqlite3.OperationalError:
        pass
    out = {}
    try:
        for rule, (table, cond) in PREDICATE.items():
            out[rule] = con.execute(
                'SELECT COUNT(*) FROM "%s" WHERE %s' % (table, cond)).fetchone()[0]
    finally:
        con.close()
    return out


def check(reset=True):
    """Confirm each rule fired on exactly the rows its own condition matches.

    NOT against a stored count. The expectation is re-derived from the source
    every run, so it cannot go stale; a mismatch now means the rule MISSED a row
    it should have caught, or caught one it should not have, which is a real
    defect rather than a calendar artefact.
    """
    exp = expected()
    bad = [k for k in exp if hits[k] != exp[k]]
    report = {k: (hits[k], exp[k]) for k in exp}
    if reset:
        for k in hits:
            hits[k] = 0
    return bad, report
