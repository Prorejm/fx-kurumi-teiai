/* ============================================================================
 * verify6.js —— T02a 验收：微观结构「接入」后的降级不变量
 * ----------------------------------------------------------------------------
 * 覆盖（本阶段只验「零影响 / 降级逐位一致」，订单流定价在 T02b 才实现）：
 *   1. micro 关闭 时 kAt === bfactorAt × swanFactor（严格逐位，Object.is）
 *   2. micro 开启 时（T02a 骨架 factor≡1）kAt 亦逐位等于 bfactorAt × swanFactor
 *   3. 全部扰动关闭(kAt===1) + Micro.factor() 严格 === 1
 *   4. 设置面板可切换 micro / microLevel 并写入存档，读档后恢复
 *   5. 旧存档兼容：缺 micro/microLevel 时读档不出现 undefined / NaN
 *   6. 零 console / page error
 * 参数化：VERIFY_URL（默认 http://127.0.0.1:8777/index.html；帝爱版传 :8778）
 * ========================================================================== */
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/彭/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:8777/index.html';
let FAIL = 0;
const log = (k, v) => console.log(String(k).padEnd(16), typeof v === 'string' ? v : JSON.stringify(v));
const ck = (k, cond, extra) => {
  if (!cond) FAIL++;
  console.log((cond ? '  PASS ' : '  FAIL ') + k + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

const CODES = ['sh600519', 'sz300750', 'sh510300', 'sh518880', 'hk00700', 'usAAPL', 'sh000300'];
const IDXS = [90, 100, 110, 120, 140, 160, 200, 260, 300, 380];

(async () => {
  const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => d.accept());

  await p.goto(URL, { waitUntil: 'load', timeout: 40000 });
  await p.waitForSelector('#intro:not(.hidden)');
  await p.click('#startBtn');
  await p.waitForSelector('.srow');
  await p.waitForTimeout(600);

  /* ============ 1. 引擎骨架存在 & 默认值 ============ */
  console.log('\n--- 1. 骨架 & 默认值 ---');
  const skel = await p.evaluate(() => ({
    microNs: !!window.Micro && typeof Micro.factor === 'function',
    stage: window.Micro && Micro.STAGE,
    defMicro: Game.DEF_OPT.micro,
    defLevel: Game.DEF_OPT.microLevel,
    optMicro: Game.G.opt.micro,
    optLevel: Game.G.opt.microLevel,
    hasMicroFactor: typeof Game.microFactor === 'function',
    enabled: window.Micro && Micro.enabled(),
    level: window.Micro && Micro.level()
  }));
  log('SKELETON', skel);
  ck('window.Micro 骨架就位', skel.microNs);
  ck('DEF_OPT.micro 默认 true', skel.defMicro === true);
  ck('DEF_OPT.microLevel 默认 std', skel.defLevel === 'std');
  ck('Game.microFactor 已导出', skel.hasMicroFactor);
  ck('Micro.enabled() 读开关', skel.enabled === true);
  ck('Micro.level() 读档位', skel.level === 'std');

  /* ============ 2. 逐位一致：kAt === bfactorAt × swanFactor ============ */
  console.log('\n--- 2. 逐位一致（核心不变量）---');
  const bitwise = await p.evaluate(({ codes, idxs }) => {
    function setup() {
      Game.reset('replay', 1, 120, {});
      Game.G.bSeed = 'b777';
      Game.G.butterfly = 0.7;
      codes.forEach(c => { Game.G.bStart[c] = 80; });
      Game.G.swans = [{
        id: 'test', tpl: 'credit', name: '测试事件', kind: 'bear', scope: 'ALL',
        drift: -0.004, days: 40, vol: 1.5, startIdx: 100, endIdx: 140, day: 'T', target: null
      }];
      Game.G.opt.blackswan = true;
      Game.G.opt.swanLevel = 3;
    }
    function sample() {
      const rows = [];
      codes.forEach(c => idxs.forEach(i => {
        const expected = Game.bfactorAt(c, i) * Game.swanFactor(c, i);   // 接入前的原式
        const got = Game.kAt(c, i);                                     // 接入后的新式
        rows.push({ c, i, expected, got, same: Object.is(expected, got) });
      }));
      return rows;
    }

    // --- micro 开启（骨架 factor≡1）---
    setup(); Game.setOpt('micro', true);
    const on = sample();

    // --- micro 关闭 ---
    setup(); Game.setOpt('micro', false);
    const off = sample();

    return {
      onN: on.length, onAllSame: on.every(r => r.same),
      offN: off.length, offAllSame: off.every(r => r.same),
      onSample: on.slice(0, 2), offSample: off.slice(0, 2),
      onNonTrivial: on.some(r => Math.abs(r.expected - 1) > 1e-6)
    };
  }, { codes: CODES, idxs: IDXS });
  log('BITWISE-ON', { n: bitwise.onN, allSame: bitwise.onAllSame });
  log('BITWISE-OFF', { n: bitwise.offN, allSame: bitwise.offAllSame });
  console.log('  sample(on) ', JSON.stringify(bitwise.onSample));
  console.log('  sample(off)', JSON.stringify(bitwise.offSample));
  ck('采样包含非平凡值（k≠1）', bitwise.onNonTrivial);
  ck('micro 开启时 kAt 逐位 === bf×swan (' + bitwise.onN + ' 点)', bitwise.onAllSame);
  ck('micro 关闭时 kAt 逐位 === bf×swan (' + bitwise.offN + ' 点)', bitwise.offAllSame);

  /* ============ 3. 全扰动关闭 → kAt === 1；Micro.factor 严格 === 1 ============ */
  console.log('\n--- 3. 关闭态归零 ---');
  const zero = await p.evaluate(({ codes }) => {
    Game.reset('replay', 1, 120, {});
    Game.setOpt('butterfly', false);   // G.butterfly=0，清 bStart
    Game.setOpt('blackswan', false);   // 清 swans
    Game.G.butterfly = 0;
    const ks = codes.map(c => Game.kAt(c, 150));
    const pxVsMarket = codes.map(c => Math.abs(Game.px(c) - Market.price(c)));
    // Micro.factor 在两个开关态下都为字面量 1
    Game.setOpt('micro', true); const fOn = Micro.factor('sh600519', 150);
    Game.setOpt('micro', false); const fOff = Micro.factor('sh600519', 150);
    return {
      allOne: ks.every(k => k === 1),
      ks: ks.slice(0, 4),
      pxZero: pxVsMarket.every(d => d < 1e-9),
      fOn, fOff, fOnIs1: fOn === 1, fOffIs1: fOff === 1,
      carry: Micro.carry('sh600519')
    };
  }, { codes: CODES });
  log('ZERO', zero);
  ck('全部扰动关闭时 kAt === 1', zero.allOne, zero.ks);
  ck('关闭时 px 严格等于市价', zero.pxZero);
  ck('Micro.factor() 开启态严格 === 1', zero.fOnIs1, zero.fOn);
  ck('Micro.factor() 关闭态严格 === 1', zero.fOffIs1, zero.fOff);
  ck('Micro.carry() 骨架阶段 === 0', zero.carry === 0);

  /* ============ 4. 设置面板切换 + 存档往返 ============ */
  console.log('\n--- 4. 设置面板 & 存档 ---');
  await p.evaluate(() => { UI.hideFx(); UI.closeModal('wealthModal'); Game.setOpt('micro', true); Game.setOpt('microLevel', 'std'); });
  await p.click('#setBtn');
  await p.waitForSelector('#setModal:not(.hidden)');
  await p.waitForTimeout(200);
  const setUi = await p.evaluate(() => ({
    switches: document.querySelectorAll('#setBody .switch').length,
    microSwitch: !!document.querySelector('#setBody .switch[data-opt="micro"]'),
    mlvlBtns: document.querySelectorAll('#setBody .mlvl-btn').length,
    lvlBtns: document.querySelectorAll('#setBody .lvl-btn').length,
    microLabel: (() => {
      const s = document.querySelector('#setBody .switch[data-opt="micro"]');
      return s ? (s.closest('.set-row').querySelector('.sr-txt b') || {}).textContent : null;
    })()
  }));
  log('SET-UI', setUi);
  ck('设置面板含 micro 开关', setUi.microSwitch, setUi.switches);
  ck('设置面板开关总数为 7', setUi.switches === 7, setUi.switches);
  ck('micro 三档选择器存在', setUi.mlvlBtns === 3, setUi.mlvlBtns);
  ck('黑天鹅档位仍为 5（未被 micro 污染）', setUi.lvlBtns === 5, setUi.lvlBtns);
  ck('micro 开关文案走 i18n（非 ⟦key⟧）', !!setUi.microLabel && setUi.microLabel.indexOf('⟦') < 0, setUi.microLabel);
  await p.screenshot({ path: 'C:/Users/彭/WorkBuddy/2026-09-28-17-03-05/shots/verify6-settings.png' });

  const roundtrip = await p.evaluate(() => {
    const before = Game.G.opt.micro;
    // 先选档位（此时开关为「开」，选择器可用）—— setOpt 会经 after() 即时存档
    const hb = document.querySelector('#setBody .mlvl-btn[data-mlvl="hard"]');
    if (hb) hb.click();
    const afterLevel = Game.G.opt.microLevel;
    // 再关闭 micro 开关（同样即时存档）
    document.querySelector('#setBody .switch[data-opt="micro"]').click();
    const afterToggle = Game.G.opt.micro;
    // 读取 UI 操作已落盘的存档
    const sv = JSON.parse(localStorage.getItem(Game.save_key));
    // 直接改内存(不经 setOpt, 避免覆盖存档), 再 restore 验证「读档回读」
    Game.G.opt.micro = true; Game.G.opt.microLevel = 'std';
    Game.restore(JSON.parse(localStorage.getItem(Game.save_key)));
    return {
      before, afterToggle, afterLevel,
      savedMicro: sv.opt.micro, savedLevel: sv.opt.microLevel,
      restoredMicro: Game.G.opt.micro, restoredLevel: Game.G.opt.microLevel
    };
  });
  log('ROUNDTRIP', roundtrip);
  ck('点击 micro 开关生效（开→关）', roundtrip.before === true && roundtrip.afterToggle === false, roundtrip.afterToggle);
  ck('选择 microLevel=hard 生效', roundtrip.afterLevel === 'hard', roundtrip.afterLevel);
  ck('存档写入 micro/microLevel', roundtrip.savedMicro === false && roundtrip.savedLevel === 'hard', roundtrip);
  ck('读档恢复 micro', roundtrip.restoredMicro === false, roundtrip.restoredMicro);
  ck('读档恢复 microLevel', roundtrip.restoredLevel === 'hard', roundtrip.restoredLevel);
  await p.click('#setModal [data-close="setModal"]');

  /* ============ 5. 旧存档兼容 ============ */
  console.log('\n--- 5. 旧存档兼容 ---');
  const legacy = await p.evaluate(() => {
    const out = {};
    // 5a. opt 中缺 micro / microLevel
    Game.reset('replay', 1, 120, {});
    Game.save();
    let sv = JSON.parse(localStorage.getItem(Game.save_key));
    delete sv.opt.micro; delete sv.opt.microLevel;
    localStorage.setItem(Game.save_key, JSON.stringify(sv));
    Game.restore(JSON.parse(localStorage.getItem(Game.save_key)));
    out.a = {
      micro: Game.G.opt.micro, level: Game.G.opt.microLevel,
      noUndef: Object.keys(Game.DEF_OPT).every(k => Game.G.opt[k] !== undefined),
      kAtFinite: Number.isFinite(Game.kAt('sh600519', Market.idx))
    };
    // 5b. 整个 opt 缺失
    Game.reset('replay', 1, 120, {});
    Game.save();
    sv = JSON.parse(localStorage.getItem(Game.save_key));
    delete sv.opt;
    localStorage.setItem(Game.save_key, JSON.stringify(sv));
    Game.restore(JSON.parse(localStorage.getItem(Game.save_key)));
    out.b = {
      micro: Game.G.opt.micro, level: Game.G.opt.microLevel,
      noUndef: Object.keys(Game.DEF_OPT).every(k => Game.G.opt[k] !== undefined),
      kAtFinite: Number.isFinite(Game.kAt('sh600519', Market.idx))
    };
    // 5c. 非法档位值 → 收敛 std
    Game.reset('replay', 1, 120, {});
    Game.save();
    sv = JSON.parse(localStorage.getItem(Game.save_key));
    sv.opt.microLevel = 'bogus';
    localStorage.setItem(Game.save_key, JSON.stringify(sv));
    Game.restore(JSON.parse(localStorage.getItem(Game.save_key)));
    out.c = { level: Game.G.opt.microLevel, kAtFinite: Number.isFinite(Game.kAt('sh600519', Market.idx)) };
    return out;
  });
  log('LEGACY-a (缺键)', legacy.a);
  log('LEGACY-b (缺 opt)', legacy.b);
  log('LEGACY-c (非法档)', legacy.c);
  ck('缺键读档 micro 回落 true', legacy.a.micro === true, legacy.a.micro);
  ck('缺键读档 microLevel 回落 std', legacy.a.level === 'std', legacy.a.level);
  ck('缺键读档无 undefined', legacy.a.noUndef);
  ck('缺键读档 kAt 有限(非 NaN)', legacy.a.kAtFinite);
  ck('缺整个 opt 读档 micro 回落 true', legacy.b.micro === true, legacy.b.micro);
  ck('缺整个 opt 读档 microLevel 回落 std', legacy.b.level === 'std', legacy.b.level);
  ck('缺整个 opt 读档 kAt 有限(非 NaN)', legacy.b.kAtFinite);
  ck('非法档位收敛 std', legacy.c.level === 'std', legacy.c.level);
  ck('非法档位后 kAt 有限', legacy.c.kAtFinite);

  /* ==========================================================================
   * T02b-CP2 验收：引力锚 / Kyle λ / carry 递推 / 存档 / 性能
   *   方法论：dev = |P_player − P_base| / P_base，其中 P_base 是「同一天、同一种子、
   *   除玩家不交易外完全相同的对照组」价格 —— 直接排除历史行情漂移的干扰。
   * ======================================================================== */

  const CODE_A = 'sh600519';
  /* 页内公共：固定种子 + 关闭蝴蝶/黑天鹅，隔离出「玩家流」这一个自变量 */
  const SETUP = `
    var CODE_A = 'sh600519';
    function prepA() {
      Game.reset('replay', 1, 120, {});
      Game.G.bSeed = 'bx';
      Game.G.butterfly = 0; Game.G.opt.blackswan = false; Game.G.swans = [];
      Game.G.opt.micro = true; Game.G.opt.microLevel = 'std';
      Game.G.realized = 1e13;
    }
    function buyFrac(code, ratio) {
      var adv = Micro.advNotional(code, Market.idx);
      var px = Game.px(code);
      var sh = Math.floor(adv * ratio / px / 100) * 100;
      if (sh <= 0) return { ok: false, msg: 'shares=0' };
      return Game.buy(code, px * 1.02, sh);
    }
  `;

  /* ============ 6. A1 弹性：dev 随 X/ADV 单调递增 ============ */
  console.log('\n--- 6. A1 弹性（偏离 vs X/ADV）---');
  const a1 = await p.evaluate(new Function('', SETUP + `
    function run(xRatio) {
      prepA();
      if (xRatio > 0) { var r = buyFrac(CODE_A, xRatio); if (!r.ok) return { err: r.msg }; }
      var t0 = Game.px(CODE_A);
      Game.stepDay(1);   var t1  = Game.px(CODE_A);
      Game.stepDay(4);   var t5  = Game.px(CODE_A);
      Game.stepDay(15);  var t20 = Game.px(CODE_A);
      Game.stepDay(100); var t120 = Game.px(CODE_A);
      return { adv: Math.round(Micro.advNotional(CODE_A, 120)), t0: t0, t1: t1, t5: t5, t20: t20, t120: t120 };
    }
    var base = run(0);
    var out = [0.1, 0.5, 1, 3].map(function (r) {
      var a = run(r);
      if (a.err) return { xAdv: r, err: a.err };
      return { xAdv: r,
        dev0:  +(a.t0  / base.t0  - 1).toFixed(6),
        dev1:  +(a.t1  / base.t1  - 1).toFixed(6),
        dev5:  +(a.t5  / base.t5  - 1).toFixed(6),
        dev20: +(a.t20 / base.t20 - 1).toFixed(6),
        dev120:+(a.t120/ base.t120- 1).toFixed(6) };
    });
    return { adv: base.adv, out: out };
  `));
  log('ADV(元)', a1.adv);
  a1.out.forEach(o => log('X/ADV=' + o.xAdv, o));
  const dev0 = a1.out.map(o => o.dev0);
  const dev1 = a1.out.map(o => o.dev1);
  ck('A1 四档全部成交（无 err）', a1.out.every(o => !o.err), a1.out.map(o => o.err || 'ok'));
  ck('A1 dev 随 X/ADV 单调递增（t0）', dev0.every((v, i) => i === 0 || v > dev0[i - 1]), dev0);
  ck('A1 dev 随 X/ADV 单调递增（t+1）', dev1.every((v, i) => i === 0 || v > dev1[i - 1]), dev1);
  /* 设计验收档位：10%≥0.3%、50%≥0.7%、100%≥1.0%、300%≥1.7% */
  const TH = [0.003, 0.007, 0.010, 0.017];
  dev0.forEach((v, i) => ck('A1 X/ADV=' + a1.out[i].xAdv + ' dev≥' + (TH[i] * 100).toFixed(1) + '%', v >= TH[i], v));

  /* ============ 7. A2 关闭归零 ============ */
  console.log('\n--- 7. A2 关闭归零 ---');
  const a2 = await p.evaluate(new Function('', SETUP + `
    prepA();
    Game.setOpt('micro', false);
    var r = buyFrac(CODE_A, 0.5);
    Game.stepDay(1);
    var k = Game.kAt(CODE_A, Market.idx);
    return { buyOk: r.ok, k: k, f: Micro.factor(CODE_A, Market.idx),
      pxDiff: Game.px(CODE_A) - Market.price(CODE_A),
      carry: Micro.carry(CODE_A) };
  `));
  log('A2', a2);
  ck('A2 micro 关闭 ⇒ dev 严格归零 (px−市价===0)', a2.pxDiff === 0, a2.pxDiff);
  ck('A2 micro 关闭 ⇒ k 严格 === 1', a2.k === 1, a2.k);
  ck('A2 micro 关闭 ⇒ Object.is(factor,1)', Object.is(a2.f, 1), a2.f);
  ck('A2 micro 关闭 ⇒ carry 不累积', a2.carry === 0, a2.carry);

  /* ============ 8. A3 无玩家交易 ⇒ 精确 1 ============ */
  console.log('\n--- 8. A3 无玩家交易 ⇒ 精确 1 ---');
  const a3 = await p.evaluate(new Function('', SETUP + `
    prepA();
    for (var i = 0; i < 30; i++) Game.stepDay(1);
    var fs = [];
    ['sh600519','sz300750','sh510300','hk00700'].forEach(function (c) { fs.push(Micro.factor(c, Market.idx)); });
    var ks = ['sh600519','sz300750','sh510300','hk00700'].map(function (c) {
      return Game.kAt(c, Market.idx) === Game.bfactorAt(c, Market.idx) * Game.swanFactor(c, Market.idx);
    });
    return { allIs1: fs.every(function (f) { return Object.is(f, 1); }), fs: fs,
      kEqualTo2Factor: ks.every(Boolean), carry: Micro.carry('sh600519'),
      pxDiff: Game.px('sh600519') - Market.price('sh600519') };
  `));
  log('A3', a3);
  ck('A3 无玩家交易 30 日 ⇒ Object.is(factor,1)', a3.allIs1, a3.fs);
  ck('A3 无玩家交易 ⇒ kAt 逐位 === bf×swan', a3.kEqualTo2Factor);
  ck('A3 无玩家交易 ⇒ carry === 0', a3.carry === 0, a3.carry);
  ck('A3 无玩家交易 ⇒ px 严格等于市价', a3.pxDiff === 0, a3.pxDiff);

  /* ============ 9. A4 持续拉抬 1~5 日偏离单调不降 ============ */
  console.log('\n--- 9. A4 持续拉抬（每日净买 20%×ADV）---');
  const a4 = await p.evaluate(new Function('', SETUP + `
    function path(ratio, days) {
      prepA();
      var seq = [], ok = true;
      for (var d = 0; d < days; d++) {
        if (ratio > 0) { var r = buyFrac(CODE_A, ratio); if (!r.ok) { ok = false; } }
        seq.push(Game.px(CODE_A));
        Game.stepDay(1);
      }
      return { seq: seq, ok: ok };
    }
    var base = path(0, 6).seq;
    var lift = path(0.2, 6);
    var dev = lift.seq.map(function (v, i) { return +(v / base[i] - 1).toFixed(6); });
    return { ok: lift.ok, dev: dev, carry: Micro.carry(CODE_A) };
  `));
  log('A4 dev(逐日)', a4.dev);
  ck('A4 持续拉抬每日成交', a4.ok);
  ck('A4 1~5 日偏离单调不降', a4.dev.every((v, i) => i === 0 || v >= a4.dev[i - 1] - 1e-9), a4.dev);
  ck('A4 末日偏离 > 首日偏离（订单流主导）', a4.dev[a4.dev.length - 1] > a4.dev[0], [a4.dev[0], a4.dev[a4.dev.length - 1]]);

  /* ============ 10. A5 20 日衰减 < 60% 峰值 / A6 120 日回归 + 半衰期 ============ */
  console.log('\n--- 10. A5/A6 中期衰减与长期回归 ---');
  const a56 = await p.evaluate(new Function('', SETUP + `
    prepA();
    buyFrac(CODE_A, 0.5);
    /* 冲量在首个 stepDay 结算，故峰值取 curve[0]（= t+1 的 |carry|） */
    var curve = [];
    for (var d = 0; d < 200; d++) { Game.stepDay(1); curve.push(Math.abs(Micro.carry(CODE_A))); }
    var peak = curve[0];
    var at20 = curve[19];
    var at120 = curve[119];
    /* 经验冲量半衰期（自峰值起首次减半所需天数） */
    var impHL = -1;
    for (var i = 0; i < curve.length; i++) { if (curve[i] <= peak / 2) { impHL = i + 1; break; } }
    /* 线性区（carry→0）半衰期 = ln2 / θ_eff(carry=0) = H / g_liq；在固定 idx=120 上求值以保证可复现 */
    Game.reset('replay', 1, 120, {});
    Market.setIdx(120);
    var th0 = Micro.thetaEff(CODE_A, 120, 0.015, 0);
    var hl = Math.LN2 / th0;
    /* 20 只标的的半衰期分布（展示 g_liq 流动性修正的影响范围） */
    var hls = Market.tradable.slice(0, 20).map(function (m) {
      return +(Math.LN2 / Micro.thetaEff(m.code, 120, 0.015, 0)).toFixed(2);
    });
    return { peak: +peak.toFixed(7), at20: +at20.toFixed(7), decay20: +(at20 / peak).toFixed(4),
      at120: +at120.toFixed(8), halfLife: +hl.toFixed(2), impulseHalfLife: impHL,
      theta0: +th0.toFixed(6), hlMin: Math.min.apply(null, hls), hlMax: Math.max.apply(null, hls) };
  `));
  log('A5/A6', a56);
  ck('A5 20 日衰减 < 60% 峰值', a56.decay20 < 0.6, a56.decay20);
  ck('A6 120 日 |carry| < 3%（回归历史锚）', a56.at120 < 0.03, a56.at120);
  ck('A6 标准档半衰期 ∈ [15,40] 日', a56.halfLife >= 15 && a56.halfLife <= 40, a56.halfLife);
  ck('A6 20 只标的半衰期全部 ∈ [15,40]', a56.hlMin >= 15 && a56.hlMax <= 40, [a56.hlMin, a56.hlMax]);

  /* ============ 11. A7 拉抬后存档 → 读档 carry 一致 ============ */
  console.log('\n--- 11. A7 存档/读档 carry 一致 ---');
  const a7 = await p.evaluate(new Function('', SETUP + `
    prepA();
    var r = buyFrac(CODE_A, 0.5);
    Game.stepDay(1);
    var c1 = Micro.carry(CODE_A);
    var f1 = Game.microFactor(CODE_A, Market.idx);
    var idx1 = Market.idx;
    Game.save();
    var sv = JSON.parse(localStorage.getItem(Game.save_key));
    var savedStr = JSON.stringify(sv.microCarry);
    /* 换一局：carry 必须清零（新局不继承上一局的拉抬）。
       注意 reset() 自身会落盘，故先把存档原文取出来，稍后用原文读档。 */
    var raw = localStorage.getItem(Game.save_key);
    Game.reset('replay', 1, 120, {});
    var cReset = Micro.carry(CODE_A);
    /* 读档：carry 与 microFactor 必须逐位还原 */
    Game.restore(JSON.parse(raw));
    var idx2 = Market.idx;
    var c2 = Micro.carry(CODE_A);
    var f2 = Game.microFactor(CODE_A, Market.idx);
    return { buyOk: r.ok, saved: !!sv.microCarry, savedStr: savedStr,
      idx1: idx1, idx2: idx2, idxSame: idx1 === idx2,
      c1: c1, c2: c2, sameCarry: Object.is(c1, c2), cReset: cReset,
      f1: f1, f2: f2, sameFactor: Object.is(f1, f2),
      k2: Game.kAt(CODE_A, Market.idx) };
  `));
  log('A7', a7);
  ck('A7 存档含 microCarry', a7.saved, a7.savedStr);
  ck('A7 新局 carry 清零', a7.cReset === 0, a7.cReset);
  ck('A7 读档交易日还原', a7.idxSame, [a7.idx1, a7.idx2]);
  ck('A7 读档 carry 逐位一致', a7.sameCarry, [a7.c1, a7.c2]);
  ck('A7 读档 microFactor 逐位一致', a7.sameFactor, [a7.f1, a7.f2]);
  ck('A7 读档后 kAt 带上玩家冲击', a7.k2 > 1, a7.k2);

  /* ============ 12. 性能实测 ============ */
  console.log('\n--- 12. 性能 ---');
  const perf = await p.evaluate(new Function('', SETUP + `
    function bench(level) {
      prepA();
      Game.setOpt('microLevel', level);
      /* 造出真实 carry：让 step 有东西可算 */
      buyFrac(CODE_A, 0.5);
      Game.stepDay(1);
      for (var i = 0; i < 10; i++) Game.stepDay(1);
      var runs = [];
      for (var j = 0; j < 50; j++) {
        var t = performance.now();
        Game.stepDay(1);
        runs.push(performance.now() - t);
      }
      runs.sort(function (a, b) { return a - b; });
      return { level: level, median: +runs[25].toFixed(3), p90: +runs[45].toFixed(3), max: +runs[49].toFixed(3) };
    }
    var res = { std: bench('std'), hard: bench('hard') };
    /* 冷启动：清空派生缓存后首次取分时（240 分钟 × 5 代理聚合） */
    Micro.reset(Game.G.bSeed);
    var t0 = performance.now();
    Micro.minute(CODE_A, Market.idx);
    res.minuteCold = +(performance.now() - t0).toFixed(2);
    var t1 = performance.now();
    for (var i = 0; i < 8; i++) Micro.minute(Market.tradable[i].code, Market.idx);
    res.minute8 = +(performance.now() - t1).toFixed(2);
    return res;
  `));
  log('PERF-std', perf.std);
  log('PERF-hard', perf.hard);
  log('PERF-minute', { hot1: perf.minuteCold, hot8: perf.minute8 });
  ck('性能：标准档 stepDay(1) 中位 < 50ms', perf.std.median < 50, perf.std.median);
  ck('性能：硬核档 stepDay(1) 中位 < 120ms', perf.hard.median < 120, perf.hard.median);

  /* ============ 13. 零 console / page error ============ */
  console.log('\n--- 13. 稳定性 ---');
  await p.evaluate(() => { Game.reset('replay', 1, 120, {}); UI.refreshAll(); });
  await p.waitForTimeout(300);
  log('ERRORS', errs);
  ck('零 console / page error', errs.length === 0);
  ck('无 ⟦缺失键⟧ 渲染', await p.evaluate(() => document.body.innerHTML.indexOf('⟦') < 0));

  console.log('\nERRORS: ' + (errs.length ? errs.join(' | ') : 'none'));
  console.log('FAILURES: ' + FAIL);
  await b.close();
  process.exit(FAIL || errs.length ? 1 : 0);
})().catch(e => { console.error('VERIFY6 FAILED:', e); process.exit(1); });
