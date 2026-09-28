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

  /* ============ 6. 零 console / page error ============ */
  console.log('\n--- 6. 稳定性 ---');
  log('ERRORS', errs);
  ck('零 console / page error', errs.length === 0);

  console.log('\nERRORS: ' + (errs.length ? errs.join(' | ') : 'none'));
  console.log('FAILURES: ' + FAIL);
  await b.close();
  process.exit(FAIL || errs.length ? 1 : 0);
})().catch(e => { console.error('VERIFY6 FAILED:', e); process.exit(1); });
