#!/usr/bin/env bash
# Verify an outbound IP is a Guangzhou RESIDENTIAL (家宽) line, not a datacenter IP.
#
# Two ways to run:
#   1) On the VPS itself, after dialing ADSL:   ./check-proxy-ip.sh
#   2) Through the proxy from anywhere:          ./check-proxy-ip.sh socks5://user:pass@host:port
#                                                ./check-proxy-ip.sh http://user:pass@host:port
#
# Exit 0 = looks good (Guangzhou + residential). Non-zero = something to look at.
set -u

PROXY="${1:-}"
CURL=(curl -s --max-time 15)
[ -n "$PROXY" ] && CURL+=(--proxy "$PROXY")

echo "== egress IP =="
IP="$("${CURL[@]}" https://api.ipify.org || true)"
if [ -z "$IP" ]; then echo "FAILED: no response (proxy down or no network)"; exit 2; fi
echo "IP: $IP"
echo

# ip-api.com returns city/region + ASN + a 'hosting' flag (true => datacenter/IDC).
echo "== geo + ASN (ip-api.com) =="
J="$("${CURL[@]}" "http://ip-api.com/json/${IP}?fields=status,country,regionName,city,isp,org,as,asname,mobile,proxy,hosting&lang=en" || true)"
echo "$J"
echo

# Pull fields without needing jq (best-effort grep).
get() { echo "$J" | grep -o "\"$1\":[^,}]*" | sed -e "s/\"$1\"://" -e 's/^"//' -e 's/"$//'; }
CITY="$(get city)"; REGION="$(get regionName)"; ASNAME="$(get asname)"; ORG="$(get org)"
HOSTING="$(get hosting)"; PROXYF="$(get proxy)"; MOBILE="$(get mobile)"

echo "== verdict =="
ok=0
echo "$REGION/$CITY" | grep -qiE "Guangdong|Guangzhou|广东|广州" \
  && echo "  [PASS] location is Guangzhou/Guangdong ($REGION / $CITY)" \
  || { echo "  [FAIL] NOT Guangzhou — got: $REGION / $CITY"; ok=1; }

echo "$HOSTING" | grep -qi true \
  && { echo "  [FAIL] flagged as HOSTING/datacenter (IDC) — this is what we are trying to avoid"; ok=1; } \
  || echo "  [PASS] not flagged as hosting/datacenter"

echo "$PROXYF" | grep -qi true \
  && echo "  [WARN] flagged as proxy/VPN in ip-api — Meituan may use similar lists" \
  || echo "  [PASS] not flagged as proxy"

echo "$ASNAME $ORG" | grep -qiE "CHINANET|CHINA TELECOM|UNICOM|CHINA169|broadband|home|residential|电信|联通|宽带|家宽" \
  && echo "  [PASS] ASN looks like a consumer broadband / 家宽 carrier ($ASNAME)" \
  || echo "  [WARN] ASN does not obviously look residential — review: $ASNAME / $ORG"

[ "$MOBILE" = "true" ] && echo "  [INFO] flagged as mobile network (4G/5G), not fixed 家宽"

echo
[ "$ok" -eq 0 ] && echo "RESULT: ✅ looks like a Guangzhou residential line" \
                || echo "RESULT: ❌ does not meet the Guangzhou-residential bar"
exit "$ok"
