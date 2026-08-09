/* Tacet date + time — the ONE place any date or time is rendered.
   Implements docs/tacet-desktop-patterns.md §1.18.

   THE RULE: the surface's language picks the convention, and then that
   convention is followed completely. English renders US dates and times.
   Chinese renders Chinese dates and times. There is no third style.

   Callers ask for a NAME, never a format:

       tdWhen(order.created_at, 'dateTime')   → "Jul 29, 2:49 PM" / "7月29日 14:49"
       tdWhen(job.eta,          'time')       → "3:40 PM"         / "15:40"
       tdWhen(row.ship_by,      'date')       → "Jul 29"          / "7月29日"
       tdRange(from, to)                      → "Jul 1 – 29"      / "7月1日–29日"
       tdTimeWindow(from, to)                 → "4:00 – 6:00 PM"  / "16:00–18:00"

   Never pass a locale, a format string, an Intl options object, or a
   .slice() index at a call site. If the eight names don't cover a case,
   that is a conversation (§1.18), not a local helper.

   Standalone on purpose — no imports, no build step, and NOT part of
   retail-admin/01-core.js, because the pages with the same drift
   (backend-account, backend-billing, pos, cms, app.html) never load the
   retail-admin parts. Include it before any script that formats a date. */

(function (root) {
  'use strict';

  /* ── The eight names (§1.18) ────────────────────────────────────────
     dateTime · date · time · weekday · month · range · relative · machine
     Anything outside this list is drift.                               */
  var NAMES = ['dateTime', 'date', 'time', 'weekday', 'month', 'range', 'relative', 'machine'];

  /* Store wall clock. Every timestamp renders in the STORE's timezone,
     never the browser's — an operator in another country must see the
     store's day, not their own. Tenant-configurable (stores carry a
     `timezone` field, see retail-admin/17-setup-guide.js); pages set
     window.TD_TZ once at boot. The fallback is Roots' value, not the
     platform's — a tenant in another zone sets TD_TZ and this constant
     never applies to them. */
  function tz() { return root.TD_TZ || 'Asia/Shanghai'; }

  /* 'en' | 'cn'. cuLang() is the admin's live language switch; standalone
     pages that have no switch get English, which is correct for them. */
  function lang() {
    try {
      if (typeof root.cuLang === 'function') return root.cuLang() === 'cn' ? 'cn' : 'en';
    } catch (e) { /* a page mid-boot has no cuLang yet — English is the safe read */ }
    return 'en';
  }

  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_EN_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* ── Parsing ────────────────────────────────────────────────────────
     SQLite stores timestamps as UTC 'YYYY-MM-DD HH:MM:SS' with NO zone
     marker. `new Date(thatString)` is parsed as LOCAL time by every
     engine, which silently shifts every stamp by the operator's UTC
     offset. This is a bug class, not a style choice — the 'Z' is not
     optional. (Reference implementation: formatDate(), 04-orders.js:2512.)

     Returns { d: Date, dayOnly: bool } or null.

     dayOnly matters: a bare 'YYYY-MM-DD' is a CALENDAR DAY, not an
     instant. Converting it through a timezone can move it to the day
     before in any negative-offset zone, so a ship-by of Jul 30 renders
     as Jul 29 and someone ships a day early. Day-only values are read
     literally and never converted. */
  function parse(v) {
    if (v === null || v === undefined || v === '') return null;
    /* NOT `v instanceof Date` — that compares constructors, so a Date
       handed over from an iframe (product-editor, the profile modal, the
       CMS panes) fails the check and silently renders as ''. Brand-check
       instead; it is realm-independent. */
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return isNaN(v.getTime()) ? null : { d: v, dayOnly: false };
    }
    if (typeof v === 'number') {
      var n = new Date(v);
      return isNaN(n.getTime()) ? null : { d: n, dayOnly: false };
    }

    var s = String(v).trim();
    if (!s) return null;

    /* Stored values are dirty in places — coupon expiry ships both
       '2026-06-09' and '2026/10/6'. Normalise separators and padding
       before deciding what kind of value this is. */
    var day = s.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})$/);
    if (day) {
      return {
        d: new Date(Date.UTC(+day[1], +day[2] - 1, +day[3])),
        dayOnly: true
      };
    }

    s = s.replace(' ', 'T');
    if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : { d: d, dayOnly: false };
  }

  /* Calendar parts in the store's timezone. en-CA gives ISO-ordered,
     zero-padded parts, which is the most reliable shape to read back —
     we are extracting numbers here, not rendering anything. */
  function parts(d, dayOnly) {
    if (dayOnly) {
      return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(),
        h: 0, mi: 0, wd: d.getUTCDay()
      };
    }
    var f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz(),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    }).formatToParts(d).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
    var wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      y: +f.year, mo: +f.month - 1, da: +f.day,
      /* Intl renders midnight as "24" under hour12:false in some engines. */
      h: (+f.hour) % 24, mi: +f.minute,
      wd: wdMap[f.weekday] === undefined ? d.getUTCDay() : wdMap[f.weekday]
    };
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* The current year, read in the STORE's timezone — not the browser's.
     On Dec 31 those disagree, and the year rule below depends on it. */
  function thisYear() {
    return +new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric' }).format(new Date());
  }

  /* ── The year rule (§1.18) ──────────────────────────────────────────
     The year appears ONLY when the date is not in the current year.
     Without this, every ops table grows a redundant ", 2026" on every
     row — and it is what makes the US format narrower than the ISO
     stamp it replaces, not wider. */
  function needsYear(p) { return p.y !== thisYear(); }

  /* ── English (US conventions) ───────────────────────────────────────
     12-hour clock with AM/PM, month-first, comma before the year.  */
  function clockEn(p) {
    var h = p.h % 12; if (h === 0) h = 12;
    return h + ':' + pad(p.mi) + ' ' + (p.h < 12 ? 'AM' : 'PM');
  }

  function renderEn(name, p) {
    var yr = needsYear(p);
    switch (name) {
      case 'dateTime':
        return MONTHS_EN[p.mo] + ' ' + p.da + (yr ? ', ' + p.y : '') + ', ' + clockEn(p);
      case 'date':
        return MONTHS_EN[p.mo] + ' ' + p.da + (yr ? ', ' + p.y : '');
      case 'time':
        return clockEn(p);
      case 'weekday':
        return WEEKDAYS_EN[p.wd] + ', ' + MONTHS_EN_LONG[p.mo] + ' ' + p.da + (yr ? ', ' + p.y : '');
      case 'month':
        return MONTHS_EN_LONG[p.mo] + ' ' + p.y;
      case 'machine':
        return p.y + '-' + pad(p.mo + 1) + '-' + pad(p.da);
    }
    return '';
  }

  /* ── Chinese ────────────────────────────────────────────────────────
     24-hour clock because that IS the Chinese convention — not because
     we kept ours and skipped the translation. Assembled by hand rather
     than through Intl('zh-CN') so the output is deterministic and
     matches §1.18's table exactly, engine to engine. */
  function renderCn(name, p) {
    var yr = needsYear(p);
    var ymd = (yr ? p.y + '年' : '') + (p.mo + 1) + '月' + p.da + '日';
    switch (name) {
      case 'dateTime': return ymd + ' ' + pad(p.h) + ':' + pad(p.mi);
      case 'date':     return ymd;
      case 'time':     return pad(p.h) + ':' + pad(p.mi);
      case 'weekday':  return ymd + ' ' + WEEKDAYS_CN[p.wd];
      case 'month':    return p.y + '年' + (p.mo + 1) + '月';
      case 'machine':  return p.y + '-' + pad(p.mo + 1) + '-' + pad(p.da);
    }
    return '';
  }

  /* ── relative ───────────────────────────────────────────────────────
     Deliberately coarse. A live nudge saying "2 min ago" is useful; one
     saying "1 min 43 sec ago" is noise pretending to be precision. */
  var REL = [
    /* limit(sec)      div      en singular/plural   cn      */
    [45,               0,       null,        null,   null],
    [3600,             60,      'min',       'min',  '分钟'],
    [86400,            3600,    'hr',        'hr',   '小时'],
    [2592000,          86400,   'day',       'days', '天'],
    [31536000,         2592000, 'month',     'months', '个月'],
    [Infinity,         31536000, 'year',     'years', '年']
  ];

  function renderRelative(d, cn) {
    var secs = (Date.now() - d.getTime()) / 1000;
    var future = secs < 0;
    var abs = Math.abs(secs);

    for (var i = 0; i < REL.length; i++) {
      if (abs >= REL[i][0]) continue;
      if (i === 0) return cn ? '刚刚' : 'just now';
      var n = Math.max(1, Math.floor(abs / REL[i][1]));
      if (cn) return future ? (n + REL[i][4] + '后') : (n + REL[i][4] + '前');
      var unit = n === 1 ? REL[i][2] : REL[i][3];
      return future ? ('in ' + n + ' ' + unit) : (n + ' ' + unit + ' ago');
    }
    return '';
  }

  /* ── tdWhen — the entry point ───────────────────────────────────────
     Returns '' for an empty or unparseable value. Callers that want a
     dash write `tdWhen(v, 'date') || '—'`, so the placeholder stays a
     decision of the page rather than a default buried in here. */
  function tdWhen(value, name, opts) {
    if (NAMES.indexOf(name) === -1) {
      throw new Error('tdWhen: "' + name + '" is not one of the eight names (§1.18): ' + NAMES.join(', '));
    }
    if (name === 'range') {
      throw new Error('tdWhen: range takes two values — call tdRange(from, to).');
    }

    var got = parse(value);
    if (!got) return '';

    var cn = (opts && opts.lang ? opts.lang : lang()) === 'cn';

    /* machine is exempt from all of this, in every language, forever —
       date inputs, CSV/XLSX exports, filenames, and every Meituan /
       Guanyi / JD / gzgrocery payload. Localising one of those breaks a
       channel SILENTLY: the request is accepted, a wrong date is stored,
       and nothing surfaces until an order ships on the wrong day. */
    if (name === 'machine') return renderEn('machine', parts(got.d, got.dayOnly));

    if (name === 'relative') return renderRelative(got.d, cn);

    /* A day-only value has no clock. Asking for its time is a caller
       bug, but returning '00:00' would be a lie that reads as real. */
    if (got.dayOnly && (name === 'time' || name === 'dateTime')) {
      name = name === 'time' ? 'date' : 'date';
    }

    var p = parts(got.d, got.dayOnly);
    return cn ? renderCn(name, p) : renderEn(name, p);
  }

  /* ── tdRange ────────────────────────────────────────────────────────
     Collapses whatever the two ends share:
       same month  →  "Jul 1 – 29"            / "7月1日–29日"
       same year   →  "Jul 1 – Aug 3"         / "7月1日–8月3日"
       neither     →  "Dec 1, 2025 – Jan 3"   / "2025年12月1日–1月3日"          */
  function tdRange(from, to, opts) {
    var a = parse(from), b = parse(to);
    if (!a && !b) return '';
    if (!a) return tdWhen(to, 'date', opts);
    if (!b) return tdWhen(from, 'date', opts);

    var cn = (opts && opts.lang ? opts.lang : lang()) === 'cn';
    var pa = parts(a.d, a.dayOnly), pb = parts(b.d, b.dayOnly);
    var sameYear = pa.y === pb.y, sameMonth = sameYear && pa.mo === pb.mo;

    if (cn) {
      var headCn = (needsYear(pa) ? pa.y + '年' : '') + (pa.mo + 1) + '月' + pa.da + '日';
      if (sameMonth) return headCn + '–' + pb.da + '日';
      var tailCn = (sameYear ? '' : (pb.y + '年')) + (pb.mo + 1) + '月' + pb.da + '日';
      return headCn + '–' + tailCn;
    }

    /* The year sits at the END of an English range when both ends share
       it — "Jul 1 – 29, 2025", not "Jul 1, 2025 – 29, 2025". */
    var tailYear = (needsYear(pa) || needsYear(pb));
    if (sameMonth) {
      return MONTHS_EN[pa.mo] + ' ' + pa.da + ' – ' + pb.da + (tailYear ? ', ' + pb.y : '');
    }
    if (sameYear) {
      return MONTHS_EN[pa.mo] + ' ' + pa.da + ' – ' + MONTHS_EN[pb.mo] + ' ' + pb.da +
        (tailYear ? ', ' + pb.y : '');
    }
    return MONTHS_EN[pa.mo] + ' ' + pa.da + ', ' + pa.y + ' – ' +
      MONTHS_EN[pb.mo] + ' ' + pb.da + ', ' + pb.y;
  }

  /* ── tdTimeWindow ───────────────────────────────────────────────────
     A delivery/pickup WINDOW — two clocks on one day, not two dates.
     `tdRange` is its date twin and this follows the same idiom: collapse
     whatever the two ends share and put it at the END in English.

       same meridiem →  "4:00 – 6:00 PM"    / "16:00–18:00"
       crossing noon →  "11:00 AM – 1:00 PM" / "11:00–13:00"

     Written HERE rather than at a call site because the surfaces that
     show a window (Orders list cell, the drawer's requested-timing tile,
     the printed slip) would otherwise each invent it — which is the
     exact drift §1.18 exists to stop. The eight NAMES stay closed: this
     is an export alongside tdRange, not a ninth name. */
  function tdTimeWindow(from, to, opts) {
    var a = parse(from), b = parse(to);
    if (!a && !b) return '';
    if (!a) return tdWhen(to, 'time', opts);
    if (!b) return tdWhen(from, 'time', opts);

    var cn = (opts && opts.lang ? opts.lang : lang()) === 'cn';
    var pa = parts(a.d, a.dayOnly), pb = parts(b.d, b.dayOnly);

    if (cn) return pad(pa.h) + ':' + pad(pa.mi) + '–' + pad(pb.h) + ':' + pad(pb.mi);

    var h12 = function (p) { var h = p.h % 12; return (h === 0 ? 12 : h) + ':' + pad(p.mi); };
    var mer = function (p) { return p.h < 12 ? 'AM' : 'PM'; };
    if (mer(pa) === mer(pb)) return h12(pa) + ' – ' + h12(pb) + ' ' + mer(pb);
    return h12(pa) + ' ' + mer(pa) + ' – ' + h12(pb) + ' ' + mer(pb);
  }

  root.tdWhen = tdWhen;
  root.tdRange = tdRange;
  root.tdTimeWindow = tdTimeWindow;
  root.TD_DATETIME_NAMES = NAMES;

  /* Also exported for Node so the §1.18 format table can be asserted
     without a browser. `public/**` lints with browser globals only, hence
     the narrow declaration rather than a blanket eslint-disable header. */
  /* global module */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tdWhen: tdWhen, tdRange: tdRange, tdTimeWindow: tdTimeWindow, NAMES: NAMES };
  }
})(typeof window !== 'undefined' ? window : globalThis);
