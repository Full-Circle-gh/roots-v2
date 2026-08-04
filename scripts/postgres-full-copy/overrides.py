#!/usr/bin/env python3
"""
The three decided value overrides (decisions 4, 6 and 7).

One module, imported by both the generator and the verifier, so the copied value
and the expected value can never drift apart. Each rule counts the rows it
touches; the run asserts those counts against what the survey found, so a rule
that silently catches more rows than expected is caught rather than trusted.
"""
import re

DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

hits = {"voucher_eod": 0, "packaging_null": 0, "updated_by_null": 0}
EXPECTED = {"voucher_eod": 1, "packaging_null": 1, "updated_by_null": 4}


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


def check(reset=True):
    """Confirm each rule fired exactly as many times as the survey predicted."""
    bad = [k for k in EXPECTED if hits[k] != EXPECTED[k]]
    report = {k: (hits[k], EXPECTED[k]) for k in EXPECTED}
    if reset:
        for k in hits:
            hits[k] = 0
    return bad, report
