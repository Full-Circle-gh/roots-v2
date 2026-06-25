# Builds the Meituan Sync — Detection-Resilience & Operational Security report (PDF).
# One-off deliverable generator. Run: python scripts/_build_meituan_security_report.py
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                PageBreak, HRFlowable, ListFlowable, ListItem)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

# CJK-capable font (renders 验证中心 / 管易 etc. + Latin) ------------------------
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
CJK = 'STSong-Light'

INK   = colors.HexColor('#1c1c1c')
OLIVE = colors.HexColor('#3f5d2e')
LIME  = colors.HexColor('#7a9a3e')
GREY  = colors.HexColor('#5b5b5b')
LIGHT = colors.HexColor('#eef1e8')
RED   = colors.HexColor('#9a3b2e')
RULE  = colors.HexColor('#c8cdbb')

styles = getSampleStyleSheet()
def S(name, **kw):
    base = kw.pop('parent', styles['Normal'])
    return ParagraphStyle(name, parent=base, **kw)

body   = S('body', fontName=CJK, fontSize=9.5, leading=14, textColor=INK, spaceAfter=6)
small  = S('small', fontName=CJK, fontSize=8, leading=11, textColor=GREY)
h1     = S('h1', fontName=CJK, fontSize=16, leading=20, textColor=OLIVE, spaceBefore=14, spaceAfter=6)
h2     = S('h2', fontName=CJK, fontSize=11.5, leading=15, textColor=INK, spaceBefore=10, spaceAfter=4)
title  = S('title', fontName=CJK, fontSize=24, leading=28, textColor=INK, spaceAfter=4)
sub    = S('sub', fontName=CJK, fontSize=11, leading=15, textColor=GREY, spaceAfter=2)
cell   = S('cell', fontName=CJK, fontSize=8.5, leading=11.5, textColor=INK)
cellh  = S('cellh', fontName=CJK, fontSize=8.5, leading=11.5, textColor=colors.white)
tag    = S('tag', fontName=CJK, fontSize=8, leading=11, textColor=OLIVE)

story = []

def rule(c=RULE, w=0.8, sb=2, sa=8):
    story.append(HRFlowable(width='100%', thickness=w, color=c, spaceBefore=sb, spaceAfter=sa))

def bullets(items, st=body):
    flow = [ListItem(Paragraph(t, st), leftIndent=6, value=None) for t in items]
    story.append(ListFlowable(flow, bulletType='bullet', start='•',
                              bulletColor=LIME, bulletFontSize=8, leftIndent=12))
    story.append(Spacer(1, 4))

def tbl(data, col_widths, header=True):
    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    ts = [
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LINEBELOW', (0,0), (-1,-1), 0.4, RULE),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, LIGHT]),
    ]
    if header:
        ts += [('BACKGROUND', (0,0), (-1,0), OLIVE),
               ('LINEBELOW', (0,0), (-1,0), 0.6, OLIVE)]
    t.setStyle(TableStyle(ts))
    story.append(t)
    story.append(Spacer(1, 8))

# ── Cover ────────────────────────────────────────────────────────────────────
story.append(Spacer(1, 30))
story.append(Paragraph('Meituan Stock-Sync', title))
story.append(Paragraph('Detection-Resilience &amp; Operational-Security Report', S('t2', parent=title, fontSize=16, textColor=OLIVE, leading=20)))
story.append(Spacer(1, 6))
story.append(Paragraph('How the automated inventory sync for the Roots Meituan merchant stores is kept stable against Meituan&rsquo;s risk-control (anti-bot) systems &mdash; controls in place, residual risks, and the recommended durable path.', sub))
rule(OLIVE, 1.2, 10, 4)
meta = [
    ['Scope', 'Roots-owned Meituan merchant stores: 天河 (Tianhe), 越秀 (Yuexiu)'],
    ['System', 'roots-v2 meituan-sync daemon (Playwright browser automation)'],
    ['Status', 'Tianhe LIVE; Yuexiu pending one-time login'],
    ['Date', '2026-06-24'],
    ['Classification', 'Internal / operational'],
]
tbl([[Paragraph(k, tag), Paragraph(v, cell)] for k,v in meta], [38*mm, 130*mm], header=False)

# ── 1. Purpose & honest framing ──────────────────────────────────────────────
story.append(Paragraph('1.  Purpose &amp; scope', h1))
rule()
story.append(Paragraph(
    'This document describes the measures that keep Roots&rsquo; <b>own</b> Meituan inventory-sync automation '
    'from being flagged by Meituan&rsquo;s automated risk-control. The automation logs into Roots&rsquo; own '
    'merchant accounts and mirrors stock levels so the Meituan storefront does not oversell while the same '
    'products sell on other channels. It does not touch other merchants, customers, payments, or Meituan&rsquo;s '
    'infrastructure beyond the normal merchant portal.', body))
story.append(Paragraph(
    '&ldquo;Detection resilience&rdquo; here means avoiding <b>operational</b> disruption &mdash; when Meituan&rsquo;s '
    'anti-bot flags the session it serves a 验证中心 (verification-centre) human captcha and invalidates the login, '
    'which stalls stock sync until a human re-authenticates. The goal of every control below is to keep the '
    'merchant&rsquo;s own session trusted and stable, not to conceal any wrongdoing.', body))
story.append(Paragraph(
    '<b>ToS note &amp; durable path.</b> Browser automation of the merchant portal is contrary to Meituan&rsquo;s '
    'terms; the officially sanctioned, detection-proof route is Meituan&rsquo;s Open API (开放平台). That remains the '
    'recommended long-term solution (section 8). The controls here reduce friction for the interim browser-based '
    'approach.', S('note', parent=body, textColor=OLIVE)))

# ── 2. Threat model ──────────────────────────────────────────────────────────
story.append(Paragraph('2.  Threat model', h1))
rule()
story.append(Paragraph('What is being detected, by whom, and what happens on detection.', body))
tbl([
    [Paragraph('Element', cellh), Paragraph('Detail', cellh)],
    [Paragraph('Adversary', cell), Paragraph('Meituan automated risk-control (not a human investigator). Goal is to stop account-takeover, fraud, and competitor scraping.', cell)],
    [Paragraph('Asset', cell), Paragraph('A trusted, logged-in merchant session per store.', cell)],
    [Paragraph('Detection &rarr; effect', cell), Paragraph('Session flagged &rarr; 验证中心 captcha on every navigation &rarr; sync stalls until a human passes it and re-logs-in.', cell)],
    [Paragraph('Consequence class', cell), Paragraph('Operational (downtime / manual toil). Not fraud, not third-party harm, not legal jeopardy &mdash; it is the merchant&rsquo;s own store.', cell)],
    [Paragraph('Risk level', cell), Paragraph('Low and self-contained: even if noticed, the activity is benign self-service inventory upkeep.', cell)],
], [42*mm, 126*mm])

# ── 3. Architecture ──────────────────────────────────────────────────────────
story.append(Paragraph('3.  Architecture overview', h1))
rule()
bullets([
    '<b>Runtime:</b> a Node/Playwright daemon (<font face="%s">meituan-sync</font>, pm2-managed) on the Hong&nbsp;Kong production box, one long-lived Chromium browser per store.' % CJK,
    '<b>Egress IP:</b> all traffic is routed through a Guangzhou datacentre proxy (Aliyun SWAS, tinyproxy :8888) so the merchant appears to connect from the store&rsquo;s own city instead of a Hong&nbsp;Kong datacentre &mdash; the single biggest historical trigger of the captcha.',
    '<b>Writes:</b> stock is set through Meituan&rsquo;s own JSON API (<font face="%s">batchUpdateSkuStock</font>), issued by the logged-in browser&rsquo;s <i>own</i> fetch &mdash; so it carries real Chrome TLS, header order and cookies, not a Node HTTP client&rsquo;s fingerprint.' % CJK,
    '<b>Reads:</b> order polling and stock reads use the same authenticated session and content iframe the merchant UI uses.',
])
story.append(Spacer(1, 4))
story.append(Paragraph('3.1  Planned egress upgrade &mdash; Guangzhou local IP', h2))
story.append(Paragraph(
    'The current egress is a Guangzhou <b>datacentre</b> proxy (tagged 阿里云). It is sufficient today, but a real '
    'Guangzhou <i>local</i> IP is cleaner still &mdash; a residential / consumer line is the least likely of all to '
    'be challenged. Two routes are planned, in preference order:', body))
tbl([
    [Paragraph('Option', cellh), Paragraph('What', cellh), Paragraph('Trade-off', cellh)],
    [Paragraph('A. Store&rsquo;s own broadband <font color="#7a9a3e">(preferred)</font>', cell),
     Paragraph('A small always-on device at the 天河 store opens a reverse tunnel (frp / ssh&nbsp;-R) out to the HK box; daemon egress exits the store&rsquo;s real Guangzhou line. Survives carrier NAT (CGNAT) &mdash; the device dials out, nothing connects in.', cell),
     Paragraph('Most authentic IP possible (literal merchant premises); ~free. Depends on store power / internet uptime; needs one device + auto-reconnect.', cell)],
    [Paragraph('B. Guangzhou residential / 家宽 proxy', cell),
     Paragraph('A Guangzhou home-broadband (ADSL / 拨号) VPS from a marketplace vendor, used as a root server (reuse the SSH tunnel) or an HTTP/SOCKS5 endpoint dropped straight into MEITUAN_PROXY_URL.', cell),
     Paragraph('Plug-and-play; ~&yen;100&ndash;250/mo. Quality varies by vendor &mdash; must be verified (below) before trusting.', cell)],
], [40*mm, 76*mm, 52*mm])
story.append(Paragraph('<b>Procurement &amp; verification rules</b> (learned the hard way &mdash; one vendor&rsquo;s &ldquo;Guangzhou&rdquo; line geolocated elsewhere):', body))
bullets([
    '<b>Verify before paying / switching:</b> confirm the exit IP geolocates to <b>Guangzhou</b> (ip138 / Taobao IP lookup) &mdash; not Shenzhen, not another city, not a datacentre tag.',
    '<b>Stable for the session:</b> the IP must hold unchanged for the whole login (~15&nbsp;min); it may only change on a <i>manual</i> redial, never auto-rotate mid-session.',
    '<b>Same IP for birth &amp; run:</b> mint the session and run the daemon through the same IP, so the login&rsquo;s origin and the daemon&rsquo;s origin match.',
    '<b>Cut-over is config-only:</b> point MEITUAN_PROXY_URL at the new endpoint and restart &mdash; no code change; the datacentre proxy stays as fallback.',
])

story.append(PageBreak())

# ── 4. Detection vectors & mitigations ───────────────────────────────────────
story.append(Paragraph('4.  Detection vectors &amp; mitigations', h1))
rule()
tbl([
    [Paragraph('Vector', cellh), Paragraph('Why it flags', cellh), Paragraph('Mitigation in place', cellh)],
    [Paragraph('IP reputation', cell), Paragraph('A Guangdong merchant connecting from a HK datacentre IP is incoherent.', cell), Paragraph('Guangzhou proxy egress; session born &amp; run on the same IP. (Strongest fix.)', cell)],
    [Paragraph('Automation flags', cell), Paragraph('navigator.webdriver / AutomationControlled = obvious bot.', cell), Paragraph('Launch flag + init-script remove the tell.', cell)],
    [Paragraph('Browser fingerprint', cell), Paragraph('Headless &amp; Linux surfaces contradict a Windows UA.', cell), Paragraph('Coherent Windows identity; headful under Xvfb; plugin/permission fills; Windows fonts.', cell)],
    [Paragraph('TLS / client', cell), Paragraph('Node HTTP client TLS != Chrome.', cell), Paragraph('Writes use the browser&rsquo;s own fetch (real Chrome stack).', cell)],
    [Paragraph('Behaviour / timing', cell), Paragraph('Robotic cadence, 3am edits, hammering after errors.', cell), Paragraph('Jitter, store-hours gating, warm-up nav, verify cool-down, slow polling.', cell)],
    [Paragraph('Session churn', cell), Paragraph('Frequent fresh logins each invite a challenge.', cell), Paragraph('Long-lived session, periodic re-persist to survive crashes.', cell)],
], [30*mm, 60*mm, 78*mm])

# ── 5. Implemented controls ──────────────────────────────────────────────────
story.append(Paragraph('5.  Implemented controls (detail)', h1))
rule()

def control(tag_txt, name, desc):
    story.append(Paragraph('<font color="#7a9a3e">%s</font>&nbsp;&nbsp;<b>%s</b>' % (tag_txt, name), h2))
    story.append(Paragraph(desc, body))

control('IP', 'Guangzhou proxy egress (Tier&nbsp;4)',
    'All daemon traffic exits via a Guangzhou datacentre proxy (8.163.120.72:8888, HK-source-locked). A fresh login through this IP reaches a clean dashboard with no 验证中心 &mdash; confirming the earlier challenges were an IP/flagged-session problem, not fingerprint. Per-store override via env; unset = direct.')
control('FP', 'Webdriver hiding (Tier&nbsp;1)',
    '<font face="%s">--disable-blink-features=AutomationControlled</font> plus an init-script forcing <font face="%s">navigator.webdriver = undefined</font> &mdash; removes the single strongest bot signal.' % (CJK, CJK))
control('FP', 'Coherent Windows identity (Tier&nbsp;2)',
    'A single consistent Windows-desktop Chrome story across UA, platform, vendor, languages, hardwareConcurrency / deviceMemory, client-hints (userAgentData + high-entropy), window.chrome.runtime, and a spoofed WebGL vendor/renderer (hides the headless SwiftShader string). Context locale zh-CN, timezone Asia/Shanghai. Internal consistency is the rule &mdash; a contradictory spoof is louder than none.')
control('FP', 'Headful under Xvfb (Tier&nbsp;3)',
    'The daemon now runs Chromium <i>headful</i> on a virtual display (Xvfb :99) instead of headless, shedding headless-only tells the init-script cannot cover. Opt-in via MEITUAN_HEADFUL=1 + DISPLAY; falls back to headless (never crashes) if the display is absent.')
control('FP', 'Headless-fallback fills',
    'For the rare headless-fallback path: synthesize navigator.plugins / mimeTypes (PDF-viewer entries) only when empty, and align navigator.permissions.query to the real Notification.permission &mdash; closing the classic headless mismatches. No-op under headful.')
control('FP', 'Windows fonts on host',
    'The Linux host now carries the Microsoft core fonts (Arial, Times, Verdana &hellip;) + Liberation metrics so font enumeration matches the claimed Windows UA instead of leaking a Linux font set.')
control('BEH', 'Behavioural timing',
    'All actions fire on jittered, randomised gaps (never a fixed cadence); the two stores are staggered, never lockstep. Order polling is deliberately slow (~5&nbsp;min &plusmn;40%) to minimise recurring page loads.')
control('BEH', 'Store-hours write gating',
    'Stock pushes are suppressed while a store is closed on Meituan &mdash; a backend edit at 3am is a bot tell, and accuracy does not matter until reopen. Rows queue and flush at open.')
control('BEH', 'Warm-up navigation',
    'Before a stock-write burst the session navigates to the inventory list (where a human edits stock) so the write API issues from the product page, not from the orders screen left over from the last poll.')
control('BEH', 'Verification cool-down',
    'On a 验证中心 hit the store is parked with an escalating back-off (30&nbsp;min &rarr; &times;2 &rarr; cap 4&nbsp;h); the daemon stops re-poking the verify page (which only deepens the flag / poisons the IP) and resumes on the next clean poll.')
control('SES', 'Session longevity',
    'One long-lived session per store; the on-disk session is re-persisted on a 30-min throttle while logged in, so a crash restores recent (rotated) cookies instead of forcing a fresh login &mdash; the riskiest event. A logged-out shell can no longer overwrite a good session file.')

story.append(PageBreak())

# ── 6. Residual risks ────────────────────────────────────────────────────────
story.append(Paragraph('6.  Residual risks', h1))
rule()
tbl([
    [Paragraph('Risk', cellh), Paragraph('Likelihood / impact', cellh), Paragraph('Note', cellh)],
    [Paragraph('Datacentre IP still tagged 阿里云', cell), Paragraph('Low / med', cell), Paragraph('A Guangzhou <i>residential</i> or store-broadband IP would be cleaner; currently sufficient.', cell)],
    [Paragraph('Proxy single point of failure', cell), Paragraph('Med / high', cell), Paragraph('If the GZ proxy is down, sync breaks. No automatic failover today.', cell)],
    [Paragraph('Segoe UI font absent', cell), Paragraph('Low / low', cell), Paragraph('Core fonts installed; Segoe UI (proprietary) not. Weak signal.', cell)],
    [Paragraph('Two stores share one fingerprint', cell), Paragraph('Low / low', cell), Paragraph('Tianhe &amp; Yuexiu identities are byte-identical; per-store variation deferred.', cell)],
    [Paragraph('Browser crash / memory pressure', cell), Paragraph('Med / med', cell), Paragraph('Crash-recovery + session re-persist mitigate; root cause is 2 Chromiums on a small box.', cell)],
    [Paragraph('ToS exposure (inherent)', cell), Paragraph('&mdash;', cell), Paragraph('Browser automation is against ToS regardless of stealth. Open API removes this entirely.', cell)],
], [52*mm, 28*mm, 88*mm])

# ── 7. Operational dependencies & runbook ────────────────────────────────────
story.append(Paragraph('7.  Operational dependencies &amp; runbook', h1))
rule()
story.append(Paragraph('Things that must stay up for the controls to hold:', body))
bullets([
    '<b>pm2 <font face="%s">xvfb</font> process</b> (Xvfb :99) &mdash; if it dies or DISPLAY is unset, the daemon silently falls back to headless (look for the &ldquo;no DISPLAY&rdquo; warning).' % CJK,
    '<b>Guangzhou proxy</b> (MEITUAN_PROXY_URL) &mdash; egress IP; if down, sync breaks.',
    '<b>Persisted sessions</b> in data/meituan-sessions/ &mdash; restored on start.',
])
story.append(Paragraph('Deploy (daemon is not redeployed by the normal CI):', h2))
bullets([
    'scp the changed lib/scripts file(s) to the box, then <font face="%s">pm2 restart meituan-sync</font>.' % CJK,
    'Verify each file landed (grep for a new symbol) <i>before</i> restarting.',
])
story.append(Paragraph('Re-login a store (human, on 验证中心 or session loss):', h2))
bullets([
    'Bring up the GZ tunnel, run the headed login helper, complete SMS + slider, copy the session up, restart the daemon.',
    'A human must pass the captcha / enter the SMS code &mdash; this step is intentionally manual.',
])

# ── 8. Recommendation ────────────────────────────────────────────────────────
story.append(Paragraph('8.  Recommendation', h1))
rule()
story.append(Paragraph(
    'The browser-based controls above are now comprehensive and the live store (Tianhe) runs clean. For a '
    '<b>durable, ToS-compliant</b> end state, migrate stock sync to <b>Meituan&rsquo;s Open API (开放平台, '
    'waimaiopen.meituan.com)</b>: it uses signed server-to-server calls with no login session and no browser, '
    'so there is no fingerprint or captcha surface at all. The browser path remains a capable fallback and the '
    'route for anything the API does not expose.', body))
story.append(Spacer(1, 6))
story.append(Paragraph(
    'Priority order if pursued further: (1) keep the Open-API migration on the roadmap; (2) add proxy failover / '
    'health alerting; (3) consider a Guangzhou residential or store-broadband egress; (4) per-store fingerprint '
    'variation.', body))

rule(OLIVE, 1.0, 12, 4)
story.append(Paragraph(
    'Prepared as internal operational documentation for the Roots / roots-v2 platform. Reflects the state of the '
    'meituan-sync daemon on 2026-06-24 (branch guanyi-stock-sync).', small))

doc = SimpleDocTemplate('Meituan-Sync-Security-Report.pdf', pagesize=A4,
                        leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=16*mm,
                        title='Meituan Stock-Sync — Detection-Resilience & Operational-Security Report',
                        author='roots-v2')

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(CJK, 7.5)
    canvas.setFillColor(GREY)
    canvas.drawString(20*mm, 10*mm, 'Meituan Stock-Sync — Operational Security  ·  Internal')
    canvas.drawRightString(190*mm, 10*mm, 'Page %d' % doc.page)
    canvas.restoreState()

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('OK wrote Meituan-Sync-Security-Report.pdf')
