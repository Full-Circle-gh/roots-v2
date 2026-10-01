#!/usr/bin/env node
/**
 * §325 M7 — POLLS ARE WRITTEN ON THE PHONE, AND THE VOTING PAGE'S SETTINGS SAVE THEMSELVES.
 *
 *   node scripts/test_mobile_voting_editor.js
 *
 * The phone's Voting screen could open and close a poll, with no confirm, and
 * nothing else: the question, the options, the rules and the page's two
 * settings were "written on desktop". It now carries the desktop's editor
 * (10-extras.js votRenderEditor / votCollect / votSavePoll / votDeletePoll)
 * and the page settings card (VOT_CARD), on the same endpoints with the same
 * bodies. Sliced out of public/m.html and run in a sandbox (fast shard), with
 * the real autosave engine (public/tacet-autosave.js). Pins:
 *   1. the list: Edit and the status button on voting:edit only; the status
 *      write asks first in the desktop's words, then sends PUT {status};
 *   2. the editor: a new poll's defaults, the desktop's holds (a question, two
 *      named options), POST / PUT / DELETE with every field votCollect sends,
 *      the publish and clear-votes confirms, refusals kept on screen, Back
 *      asking only when something is unsaved, the reload guard;
 *   3. the page settings: PUT /voting/config?history=voting, the desktop's
 *      three fields, started only once the stored ones arrived, history read
 *      from snapshot['voting.config'];
 *   4. without voting:edit nothing writes.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
const slice = (src, a, b) => {
  const s = src.indexOf(a), e = src.indexOf(b, s + 1);
  if (s < 0 || e < 0) throw new Error('slice not found: ' + a);
  return src.slice(s, e);
};
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const VOTING_SRC = slice(MH, '/* ==========================================================================\n   Voting — the polls customers answer', '/* ==========================================================================\n   Membership, Top-up and Leaderboard');

const POLLS = () => [
  { id: 1, question_en: 'Next flavour', question_cn: '下款口味', category_en: 'New flavour', category_cn: '新口味', explainer_en: 'Pick one', explainer_cn: '选一个',
    status: 'open', reward_points: 5, is_featured: 1, sort_order: 2, display_min_total: 0, closes_at: '2026-10-08 12:00:00', winner_option_id: null, total_votes: 10,
    options: [{ id: 11, label_en: 'Matcha', label_cn: '抹茶', color_hex: '#F2CA6C', votes: 7 }, { id: 12, label_en: 'Sesame', label_cn: '芝麻', color_hex: '#F4B8CB', votes: 3 },
      { id: 13, label_en: 'Yuzu', label_cn: '柚子', color_hex: '#F4F087', votes: 0 }] },
  { id: 2, question_en: 'Store hours', question_cn: '', status: 'draft', reward_points: 0, is_featured: 0, sort_order: 0, display_min_total: 0, winner_option_id: null,
    options: [{ id: 21, label_en: 'Until 21:00', votes: 0 }, { id: 22, label_en: 'Until 22:00', votes: 0 }] },
  { id: 3, question_en: 'Bag design', status: 'closed', reward_points: 5, is_featured: 0, sort_order: 0, display_min_total: 0, winner_option_id: null,
    options: [{ id: 31, label_en: 'Kraft', votes: 60 }, { id: 32, label_en: 'Canvas', votes: 20 }] },
];
const VOTCFG = { intro_en: 'Polls close Sundays. {pts} pts.', intro_cn: '周日截止。{pts} 积分。', show_counts: true };

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  let histSheet = null, renders = 0;
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T,
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { success: ['g', 'G'], clear: ['c', 'C'], muted: ['m', 'M'], warning: ['w', 'W'] },
    nothingYet: (a, b) => `<empty>${a}|${b}</empty>`,
    noteBar: (t) => `<note>${t}</note>`,
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    fmtDay: (d) => String(d).slice(0, 10),
    state: { polls: opts.polls === undefined ? POLLS() : opts.polls, pollsTried: true, pollsErr: null, pollOpen: null, pollBusy: null,
      caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null, stack: [{ route: 'voting' }] },
    render: () => { renders++; },
    forgetScroll: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error('refused'); e.refused = true; e.words = ['Your role cannot change polls.', '你的角色不能修改投票。']; throw e; }
      if (opts.writeBreaks) throw new Error('500');
      return { success: true, data: {} };
    },
    api: async (p) => {
      reads.push(p);
      if (p === '/voting/config') { if (opts.cfgFails) throw new Error('network'); return opts.votcfg || Object.assign({}, VOTCFG); }
      if (p.startsWith('/config/history')) return opts.history || { success: true, versions: [] };
      if (p === '/polls') return POLLS();
      return {};
    },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + VOTING_SRC +
    '\nthis.pe=()=>PE; this.votD=()=>VOT_D; this.votErr=()=>VOT_ERR; this.card=(k)=>CFG_CARD[k]; this.pollMayLeave=pollMayLeave;' +
    ' this.screenPollEdit=screenPollEdit; this.screenVoting=screenVoting; this.cfgFootHtml=cfgFootHtml; this.pollBoostLine=pollBoostLine;', ctx);
  return { ctx, CMD, writes, reads, toasts, hist: () => histSheet, renders: () => renders };
}
const yes = (ctx) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(); };
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;

section('1 · the list: the status write asks first');
{
  it('each card: See results, the status button and Edit; the status button asks, it does not write', () => {
    const { ctx, writes } = mk();
    const html = ctx.screenVoting();
    assert.ok(/APP\.cmd\('pollAsk',1,'closed'\)[^>]*>Close</.test(html), 'an open poll offers Close');
    assert.ok(/APP\.cmd\('pollAsk',2,'open'\)[^>]*>Open</.test(html), 'a draft offers Open (the label the slow suite reads)');
    assert.ok(/APP\.cmd\('pollAsk',3,'open'\)[^>]*>Reopen</.test(html), 'a closed one offers Reopen');
    assert.ok(/APP\.cmd\('pollEdit',1\)[^>]*>Edit</.test(html) && /APP\.cmd\('pollEdit',3\)/.test(html));
    assert.ok(!/APP\.cmd\('pollStatus'/.test(html), 'no control writes without the confirm');
    assert.ok(!/on desktop|电脑端/.test(html), 'nothing is "written on desktop" any more');
    assert.strictEqual(writes.length, 0);
  });
  it('publishing a draft: the desktop\'s words, then PUT /polls/2 {status:"open"}, then the list is read again', async () => {
    const { ctx, CMD, writes, reads, toasts } = mk();
    CMD.pollAsk(2, 'open');
    assert.strictEqual(ctx.state.ask.title, 'Publish this poll? Customers see it immediately and start earning points for voting.');
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Publish poll');
    assert.strictEqual(writes.length, 0, 'nothing is sent before the answer');
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/polls/2', method: 'PUT', body: { status: 'open' } }]);
    assert.deepStrictEqual(toasts, ['Poll published']);
    assert.ok(reads.includes('/polls'));
  });
  it('closing and reopening ask in the desktop\'s words too', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.pollAsk(1, 'closed');
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel], ['Close this poll? Voting locks and the result moves to past results.', 'Close poll']);
    yes(ctx); await tick();
    CMD.pollAsk(3, 'open');
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel], ['Reopen this poll? Customers can vote again.', 'Reopen poll']);
    yes(ctx); await tick();
    assert.deepStrictEqual(plain(writes.map((w) => [w.p, w.body.status])), [['/polls/1', 'closed'], ['/polls/3', 'open']]);
  });
  it('a refused status write says why on the list, and the busy mark clears', async () => {
    const { ctx, CMD } = mk({ writeFails: true });
    CMD.pollAsk(1, 'closed'); yes(ctx); await tick();
    assert.strictEqual(String(ctx.state.pollsErr), 'Your role cannot change polls.');
    assert.strictEqual(ctx.state.pollBusy, null);
  });
  it('the empty and failed lists: the desktop\'s first-poll line; the failure, not "none yet"', () => {
    const e = mk({ polls: [] });
    const h = e.ctx.screenVoting();
    assert.ok(h.includes('<empty>No polls yet|Your first poll takes about a minute. It lands on Me → Your say.</empty>'));
    const f = mk();
    f.ctx.state.pollsErr = 'Could not load the polls.';
    const h2 = f.ctx.screenVoting();
    assert.ok(h2.includes('Could not load the polls.') && !h2.includes('No polls yet'));
    const l = mk({ polls: null });
    assert.ok(l.ctx.screenVoting().includes('Loading…'));
  });
}

section('2 · the editor');
{
  it('New poll: the desktop\'s blank (5 points, two coloured options, a draft), on its own screen', () => {
    const { ctx, CMD } = mk();
    CMD.pollEdit();
    assert.strictEqual(top(ctx), 'polledit');
    const d = ctx.pe().d;
    assert.deepStrictEqual(plain([d.id, d.status, d.reward_points, d.is_featured, d.display_min_total, d.options.map((o) => o.color_hex)]),
      [null, 'draft', 5, 0, 0, ['#F2CA6C', '#F4B8CB']]);
    const html = ctx.screenPollEdit();
    for (const w of ['New. Nothing is saved until you save it.', 'Question', 'Small label above it', 'Line under the question', 'Add option', 'Points for voting',
      'Closes', 'Feature it', 'Featured', 'Order', 'Show at least', 'Publish', 'Save draft', 'Off. Nothing is scaled until the first real vote.']) assert.ok(html.includes(w), w);
    assert.ok(!html.includes('>Delete<') && !html.includes('Winner'), 'no Delete and no Winner on a new poll');
  });
  it('the holds: no question → said beside the field, nothing sent; fewer than two named options → said, nothing sent', () => {
    const { ctx, CMD, writes } = mk();
    CMD.pollEdit();
    CMD.pollSave('');
    assert.strictEqual(String(ctx.pe().qErr), 'Give the poll a question — customers see this line first.');
    CMD.pollEdSet('question_en', 'Best day?');
    CMD.pollEdOpt(0, 'label_en', 'Monday');
    CMD.pollSave('');
    assert.strictEqual(String(ctx.pe().err), 'A poll needs at least two options to choose between.');
    assert.strictEqual(writes.length, 0);
  });
  it('Save draft: POST /polls with every field votCollect sends, unnamed options left out, label_en filled from Chinese', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.pollEdit();
    CMD.pollEdLang('cn');
    CMD.pollEdSet('question_cn', ' 哪天最好？ ');
    CMD.pollEdSet('category_cn', '营业');
    CMD.pollEdOpt(0, 'label_cn', '周一');
    CMD.pollEdOpt(1, 'label_cn', '周二');
    CMD.pollEdAdd();
    CMD.pollEdSet('reward_points', '8');
    CMD.pollEdSet('is_featured', 1);
    CMD.pollEdSet('closes_at', '2026-10-09T18:00');
    CMD.pollEdSet('sort_order', '3');
    CMD.pollEdSet('display_min_total', '40');
    CMD.pollSave('');
    await tick();
    assert.deepStrictEqual(writes, [{ p: '/polls', method: 'POST', body: {
      question_en: '哪天最好？', question_cn: '哪天最好？', category_en: '', category_cn: '营业', explainer_en: '', explainer_cn: '',
      status: 'draft', reward_points: 8, is_featured: 1, closes_at: '2026-10-09T18:00', sort_order: 3, display_min_total: 40,
      options: [{ id: null, label_en: '周一', label_cn: '周一', color_hex: '#F2CA6C', image_url: '', sort_order: 0 },
        { id: null, label_en: '周二', label_cn: '周二', color_hex: '#F4B8CB', image_url: '', sort_order: 1 }] } }]);
    assert.deepStrictEqual(toasts, ['Poll created']);
    assert.strictEqual(ctx.pe(), null);
    assert.strictEqual(top(ctx), 'voting', 'back on the list, which is read again');
  });
  it('Publish on a new poll asks first, then POSTs it open', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.pollEdit();
    CMD.pollEdSet('question_en', 'Q');
    CMD.pollEdOpt(0, 'label_en', 'A'); CMD.pollEdOpt(1, 'label_en', 'B');
    CMD.pollSave('open');
    assert.strictEqual(ctx.state.ask.confirmLabel, 'Publish poll');
    assert.strictEqual(writes.length, 0);
    yes(ctx); await tick();
    assert.strictEqual(writes[0].p, '/polls');
    assert.strictEqual(writes[0].body.status, 'open');
    assert.deepStrictEqual(toasts, ['Poll published']);
  });
  it('editing a live poll: PUT /polls/1, option ids kept, the winner and the (unticked) clear-votes flag sent', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.pollEdit(1);
    assert.strictEqual(ctx.pe().d.closes_at, '2026-10-08T12:00', 'the stored time, as the datetime field takes it');
    const html = ctx.screenPollEdit();
    assert.ok(html.includes('Open. Customers can vote on it now.') && html.includes('Save changes') && /pollAsk',1,'closed'\)[^>]*>Close poll</.test(html));
    assert.ok(html.includes('Clear all 10 votes and rebuild the options'), 'there are votes to clear');
    assert.ok(/pollEdRemove',0\)[^>]*disabled|disabled[^>]*pollEdRemove',0\)/.test(html.replace(/\n\s*/g, ' ')), 'an option with votes cannot be removed');
    CMD.pollEdRemove(0);
    assert.strictEqual(ctx.pe().d.options.length, 3, '…nor by command');
    CMD.pollEdRemove(2);
    CMD.pollEdOpt(1, 'label_en', 'Black sesame');
    CMD.pollSave('');
    await tick();
    assert.strictEqual(writes.length, 1);
    const w = writes[0];
    assert.deepStrictEqual([w.p, w.method], ['/polls/1', 'PUT']);
    assert.deepStrictEqual(plain(w.body.options.map((o) => [o.id, o.label_en, o.sort_order])), [[11, 'Matcha', 0], [12, 'Black sesame', 1]]);
    assert.strictEqual(w.body.winner_option_id, null);
    assert.strictEqual(w.body.replace_options, false);
    assert.deepStrictEqual([w.body.closes_at, w.body.is_featured, w.body.sort_order, w.body.status], ['2026-10-08T12:00', 1, 2, 'open']);
    assert.deepStrictEqual(toasts, ['Poll saved']);
  });
  it('clearing the votes asks, as a danger, before the PUT carries replace_options', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.pollEdit(1);
    CMD.pollEdReset(true);
    CMD.pollSave('');
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel, ctx.state.ask.danger],
      ['Clear every vote on this poll? The tally cannot be recovered.', 'Clear votes', true]);
    assert.strictEqual(writes.length, 0);
    yes(ctx); await tick();
    assert.strictEqual(writes[0].body.replace_options, true);
  });
  it('a closed poll: Reopen, and the Winner choice sent as a number', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.pollEdit(3);
    const html = ctx.screenPollEdit();
    assert.ok(html.includes('Closed. It shows under past results.') && html.includes('The most-voted option') && /pollAsk',3,'open'\)[^>]*>Reopen</.test(html));
    CMD.pollEdSet('winner_option_id', '32');
    CMD.pollSave('');
    await tick();
    assert.strictEqual(writes[0].body.winner_option_id, 32);
  });
  it('Close poll from inside the editor: confirmed, sent, and the editor takes the new state', async () => {
    const { ctx, CMD, writes } = mk();
    CMD.pollEdit(1);
    CMD.pollEdSet('question_en', 'Typed but not saved');
    CMD.pollAsk(1, 'closed'); yes(ctx); await tick();
    assert.deepStrictEqual(writes[0], { p: '/polls/1', method: 'PUT', body: { status: 'closed' } });
    assert.strictEqual(ctx.pe().d.status, 'closed');
    assert.strictEqual(ctx.pe().d.question_en, 'Typed but not saved', 'what is being typed is kept');
  });
  it('a refused save stays on the editor with the reason; the draft is kept', async () => {
    const { ctx, CMD } = mk({ writeFails: true });
    CMD.pollEdit(2);
    CMD.pollSave('');
    await tick();
    assert.strictEqual(String(ctx.pe().err), 'Your role cannot change polls.');
    assert.strictEqual(ctx.pe().busy, null);
    assert.strictEqual(top(ctx), 'polledit');
    assert.ok(ctx.screenPollEdit().includes('Your role cannot change polls.'));
    const b = mk({ writeBreaks: true });
    b.CMD.pollEdit(); b.CMD.pollEdSet('question_en', 'Q'); b.CMD.pollEdOpt(0, 'label_en', 'A'); b.CMD.pollEdOpt(1, 'label_en', 'B');
    b.CMD.pollSave(''); await tick();
    assert.strictEqual(String(b.ctx.pe().err), 'Could not create the poll');
  });
  it('Delete: asks with the vote count, as a danger, then DELETE /polls/1; a failure stays on screen', async () => {
    const { ctx, CMD, writes, toasts } = mk();
    CMD.pollEdit(1);
    CMD.pollDelete();
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel, ctx.state.ask.danger], ['Delete this poll? Its 10 votes go with it.', 'Delete poll', true]);
    yes(ctx); await tick();
    assert.deepStrictEqual(plain(writes.map((w) => [w.p, w.method])), [['/polls/1', 'DELETE']]);
    assert.deepStrictEqual(toasts, ['Poll deleted']);
    assert.strictEqual(top(ctx), 'voting');
    const f = mk({ writeBreaks: true });
    f.CMD.pollEdit(2); f.CMD.pollDelete();
    assert.strictEqual(f.ctx.state.ask.title, 'Delete this poll?');
    yes(f.ctx); await tick();
    assert.strictEqual(String(f.ctx.pe().err), 'Delete failed');
  });
  it('Back: leaves at once when nothing changed; asks, in the desktop\'s words, when something did', () => {
    const a = mk();
    a.CMD.pollEdit(1);
    assert.strictEqual(a.ctx.pollMayLeave(), true);
    const b = mk();
    b.CMD.pollEdit(1);
    b.CMD.pollEdOpt(0, 'label_en', 'x');
    assert.strictEqual(b.ctx.pollMayLeave(), false);
    assert.deepStrictEqual([b.ctx.state.ask.title, b.ctx.state.ask.confirmLabel, b.ctx.state.ask.danger],
      ['Leave without saving? The changes on this page are lost.', 'Leave', true]);
    yes(b.ctx);
    assert.strictEqual(top(b.ctx), 'voting');
    assert.strictEqual(b.ctx.pe(), null);
  });
  it('the app\'s Back, the edge swipe and the reload guard all know the editor', () => {
    assert.ok(MH.includes("if(top==='polledit'&&!pollMayLeave()) return;"));
    assert.ok(MH.includes("if(t&&t.route==='polledit'&&!pollMayLeave()) return;"));
    assert.ok(MH.includes("if(PE&&PE.dirty&&(state.stack||[]).some(f=>f&&f.route==='polledit')) return true;"));
    assert.ok(/polledit:'voting:edit'/.test(MH), 'the editor opens on voting:edit');
  });
  it('options: eight at most; the display floor\'s line is the desktop\'s arithmetic', () => {
    const { ctx, CMD } = mk();
    CMD.pollEdit();
    for (let i = 0; i < 10; i++) CMD.pollEdAdd();
    assert.strictEqual(ctx.pe().d.options.length, 8);
    assert.deepStrictEqual(plain(ctx.pe().d.options.map((o) => o.color_hex)), ['#F2CA6C', '#F4B8CB', '#F4F087', '#E96174', '#B2CFED', '#7BBD3B', '#A8D185', '#FFAF60']);
    const d = POLLS()[0];
    assert.strictEqual(ctx.pollBoostLine(Object.assign(d, { display_min_total: 0 })), 'Off. Customers see the real 10 votes.');
    assert.strictEqual(ctx.pollBoostLine(Object.assign(d, { display_min_total: 50 })), 'Customers will see about 50 votes — every option ×5.0.');
  });
}

section('3 · the page settings: a card on /voting/config');
{
  it('reads the stored settings, then starts; the line and the switch are on the screen', async () => {
    const { ctx, reads } = mk();
    ctx.screenVoting(); await tick();
    assert.ok(reads.includes('/voting/config'));
    assert.ok(ctx.card('voting') && ctx.card('voting').auto, 'started once they arrived');
    const html = ctx.screenVoting();
    assert.ok(html.includes('Page settings') && html.includes('Polls close Sundays. {pts} pts.') && html.includes('Show vote counts to customers'));
    assert.ok(html.includes('On. Customers see the tallies and percentages.') && html.includes('cmd="APP.cmd(\'votCounts\')"'));
    assert.ok(/APP\.cmd\('cfgHistory','voting'\)/.test(html));
  });
  it('the line\'s sheet: English and 中文, 240 at most; a change sends the desktop\'s three fields, trimmed', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenVoting(); await tick();
    CMD.votIntroEdit();
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'The line under “Your say”');
    assert.deepStrictEqual(plain(a.fields.map((f) => [f.id, f.label, f.max])), [['intro_en', 'English', 240], ['intro_cn', '中文', 240]]);
    live(ctx).set('intro_en', '  Vote by Sunday.  '); live(ctx).auto.touch();
    await live(ctx).auto.flush();
    assert.deepStrictEqual(writes, [{ p: '/voting/config?history=voting', method: 'PUT', body: { intro_en: 'Vote by Sunday.', intro_cn: '周日截止。{pts} 积分。', show_counts: true } }]);
  });
  it('the switch sends show_counts and says what it means', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenVoting(); await tick();
    CMD.votCounts();
    await ctx.card('voting').auto.flush();
    assert.strictEqual(writes[0].body.show_counts, false);
    assert.ok(ctx.screenVoting().includes('Off. Customers see which option leads, never the numbers.'));
  });
  it('Version history reads card=voting and restores snapshot[\'voting.config\'] as a restore', async () => {
    const versions = [{ id: 2, at: 'x', changed: ['voting.config'], snapshot: { 'voting.config': { intro_en: 'Old', intro_cn: '旧', show_counts: false } } }];
    const { ctx, CMD, writes, reads, hist } = mk({ history: { success: true, versions } });
    ctx.screenVoting(); await tick();
    CMD.cfgHistory('voting'); await tick();
    assert.ok(reads.includes('/config/history?card=voting'));
    assert.strictEqual(hist().sub(versions[0]), 'Page settings');
    await hist().restore(versions[0]);
    assert.deepStrictEqual(writes[writes.length - 1], { p: '/voting/config?history=voting&note=restore', method: 'PUT', body: { intro_en: 'Old', intro_cn: '旧', show_counts: false } });
  });
  it('a refused save stays in the foot', async () => {
    const { ctx, CMD } = mk({ writeFails: true });
    ctx.screenVoting(); await tick();
    CMD.votCounts();
    await ctx.card('voting').auto.flush();
    assert.ok(/Save failed: /.test(ctx.cfgFootHtml(ctx.card('voting'))));
  });
  it('if the stored settings do not arrive, the card never starts and says so', async () => {
    const { ctx, CMD, writes } = mk({ cfgFails: true });
    ctx.screenVoting(); await tick();
    assert.strictEqual(String(ctx.votErr()), 'Could not load this.');
    assert.ok(!ctx.card('voting'));
    CMD.votCounts(); CMD.votIntroEdit();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
    assert.ok(ctx.screenVoting().includes('Could not load this.'));
  });
}

section('4 · without voting:edit nothing writes');
{
  it('no New poll, no Edit, no status button, no settings controls; the commands do nothing', async () => {
    const { ctx, CMD, writes } = mk({ caps: ['orders:view'] });
    const html = ctx.screenVoting(); await tick();
    assert.ok(!/pollEdit|pollAsk/.test(html));
    assert.ok(!ctx.card('voting'), 'the settings card is not started');
    const html2 = ctx.screenVoting();
    assert.ok(!/votIntroEdit|votCounts|cfgHistory/.test(html2));
    CMD.pollEdit(); CMD.pollEdit(1); CMD.pollAsk(1, 'closed'); CMD.pollStatus(1, 'closed'); CMD.votCounts(); CMD.votIntroEdit();
    assert.strictEqual(ctx.pe(), null);
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
    const sub = MH.slice(MH.indexOf("  voting:{title:['Voting','投票'],"), MH.indexOf('render:()=>screenVoting()}'));
    assert.ok(/cta:\(\)=>mCan\('voting:edit'\)\?/.test(sub), 'New poll is drawn on voting:edit only');
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
