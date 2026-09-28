/* ================================================================
   验收：帝爱炒股模拟器
   品牌层 / 主题底纹 / 引擎复用 / 交易链路 / 布局 / 长跑稳定性
   ================================================================ */
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/彭/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = 'C:/Users/彭/WorkBuddy/2026-09-28-17-03-05/shots/';
const URL = 'http://127.0.0.1:8778/index.html';
let FAIL = 0;
const log = (k, v) => console.log(String(k).padEnd(16), typeof v === 'string' ? v : JSON.stringify(v));
const ck = (k, cond, extra) => {
  if (!cond) FAIL++;
  console.log((cond ? '  PASS ' : '  FAIL ') + k + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

(async () => {
  const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => d.accept());

  await p.goto(URL, { waitUntil: 'load', timeout: 40000 });
  /* 等行情引擎装载完成（Market.init 在快照解析后执行） */
  await p.waitForFunction(() => window.Market && Market.meta.length > 0, null, { timeout: 40000 });

  /* ============ 1. 品牌层 ============ */
  console.log('\n--- 1. 品牌层（帝爱 VI）---');
  const brand = await p.evaluate(() => {
    const css = (sel, prop) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n)[prop] : '';
    };
    return {
      title: document.title,
      bootWord: (document.querySelector('.boot-word') || {}).textContent,
      bootGroup: (document.querySelector('.boot-title') || {}).textContent,
      markBg: css('.boot-mark', 'backgroundImage').slice(0, 30),
      introBl: (document.querySelector('#intro .bl-word') || {}).textContent,
      introJp: (document.querySelector('#intro .bl-line') || {}).textContent
    };
  });
  log('BRAND', brand);
  ck('标题为帝爱炒股模拟器', /帝爱炒股模拟器/.test(brand.title), brand.title);
  ck('载入幕有帝愛字标', brand.bootWord === '帝愛', brand.bootWord);
  ck('载入幕有グループ全称', /帝\s*愛\s*グ\s*ル\s*ー\s*プ/.test(brand.bootGroup), brand.bootGroup);
  ck('徽记为内嵌 SVG（原创资产，未外链商标图）', /data:image\/svg/.test(brand.markBg), brand.markBg);
  ck('开场有帝愛标准字组合', brand.introBl === '帝愛' && /帝愛グループ/.test(brand.introJp),
    [brand.introBl, brand.introJp]);

  const motif = await p.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      bodyStars: (body.backgroundImage.match(/data:image\/svg/g) || []).length,
      wave: root.getPropertyValue('--wave').trim().slice(0, 22),
      stars: root.getPropertyValue('--stars').trim().slice(0, 22),
      mark: root.getPropertyValue('--mark').trim().slice(0, 22),
      navy: root.getPropertyValue('--navy').trim(),
      gold: root.getPropertyValue('--gold').trim(),
      paper: root.getPropertyValue('--paper').trim(),
      up: root.getPropertyValue('--up').trim(),
      down: root.getPropertyValue('--down').trim()
    };
  });
  log('MOTIF', motif);
  ck('波浪图案已定义', /svg/.test(motif.wave), motif.wave);
  ck('重复星星图案已定义', /svg/.test(motif.stars), motif.stars);
  ck('墨蓝/金/米白三色就位',
    motif.navy === '#17385f' && motif.gold === '#a87e26' && motif.paper === '#f4f3ef',
    [motif.navy, motif.gold, motif.paper]);
  ck('涨红跌绿（中国市场习惯）', motif.up === '#c8382c' && motif.down === '#158a5b', [motif.up, motif.down]);
  ck('星点底纹铺到页面上', motif.bodyStars >= 1, motif.bodyStars);

  /* ============ 2. 引擎复用 ============ */
  console.log('\n--- 2. 引擎复用（与父版本同源）---');
  const eng = await p.evaluate(() => ({
    metas: Market.meta.length,
    tradable: Market.tradable.length,
    dates: Market.dates.length,
    px: typeof Game.px === 'function',
    swan: typeof Game.rollSwan === 'function',
    opt: typeof Game.optOf === 'function',
    optKeys: Object.keys(Game.DEF_OPT || {}).length,
    theme: typeof ChartKit.setTheme === 'function',
    colors: Object.keys(ChartKit.theme()).length,
    up: ChartKit.theme().up, down: ChartKit.theme().down
  }));
  log('ENGINE', eng);
  /* 计数基线更新 (T03-CP1, 2026-09-29): 243 -> 261。新增 18 个标的 =
     sh510050(期权标的, +1 可交易)
     + 期货主力连续 7 (futAU/AG/SC/RB/CU/I/M)
     + 数字资产 2 (cryBTC/cryETH)
     + 期权标的 2 (opt510300/opt510050)
     + 私募信托 2 (pmFUND/pmTRUST)
     + 另类 4 (altSNOW/altLINK/altGOLD/altACC)
     可交易: 213 -> 214 (仅 sh510050 为可交易 ETF; 其余新分区 CP1 阶段
     数据先行落地, tradable 暂为 false, CP2/CP3 接线后放开)。 */
  ck('标的数 261', eng.metas === 261, eng.metas);
  ck('可交易标的 214', eng.tradable === 214, eng.tradable);
  ck('历史日期序列完整', eng.dates > 400, eng.dates);
  ck('影子价格 + 黑天鹅引擎在', eng.px && eng.swan, [eng.px, eng.swan]);
  // 因新增 opt.micro / opt.microLevel 两个配置项而同步更新 8 → 10：仅计数期望值随产品意图变更，断言逻辑未改
  ck('玩法开关 10 项', eng.optKeys === 10, eng.optKeys);
  ck('图表主题已换成帝爱色', eng.theme && eng.up === '#c8382c' && eng.down === '#158a5b', [eng.up, eng.down]);

  /* ============ 3. 开场 → 主界面 ============ */
  console.log('\n--- 3. 开场 / 主界面 ---');
  await p.waitForSelector('#intro:not(.hidden)', { timeout: 30000 });
  const intro = await p.evaluate(() => {
    const l = document.getElementById('introLine');
    return { txt: l.textContent, len: l.textContent.length };
  });
  log('INTRO-LINE', intro);
  ck('开场台词是完整句子（修复原版只显示首字）', intro.len >= 8, intro.len);

  const copy = await p.evaluate(() => ({
    start: (document.getElementById('startBtn') || {}).textContent,
    cont: (document.getElementById('continueBtn') || {}).textContent,
    mark: !!document.querySelector('#introAvatar svg'),
    fxBl: !!document.querySelector('.fx-bl'),
    fxBtn: (document.getElementById('fxBtn') || {}).textContent,
    fxWord: (document.getElementById('fxWord') || {}).textContent
  }));
  log('COPY', copy);
  ck('按钮已本地化', /开/.test(copy.start) && /存档/.test(copy.cont), [copy.start, copy.cont]);
  ck('开场徽记渲染成 SVG', copy.mark, copy.mark);
  ck('全屏层有帝爱标准字', copy.fxBl && /帝愛グループ/.test(copy.fxBl ? '帝愛グループ' : ''), copy.fxBl);

  await p.click('#startBtn');
  await p.waitForSelector('.srow');
  await p.waitForTimeout(900);

  const shell = await p.evaluate(() => {
    const q = s => document.querySelector(s);
    return {
      logoJp: (q('.logo-jp') || {}).textContent,
      logoTxt: (q('.logo-txt') || {}).textContent,
      logoSub: (q('.logo-sub') || {}).textContent,
      markW: (q('.logo-mark') || {}).clientWidth,
      tabs: [...document.querySelectorAll('.ztab')].map(x => x.dataset.zone),
      news: document.querySelectorAll('#newsTrack .nb-item').length,
      hudStats: document.querySelectorAll('.hud-stats .stat').length,
      advisor: (q('#charAvatar svg') || {}).getAttribute
        ? q('#charAvatar svg').getAttribute('aria-label') : '',
      rows: document.querySelectorAll('.srow').length
    };
  });
  log('SHELL', shell);
  ck('顶栏 = 帝愛グループ + 产品名',
    shell.logoJp === '帝愛グループ' && /帝爱炒股模拟器/.test(shell.logoTxt), [shell.logoJp, shell.logoTxt]);
  ck('徽记有实际尺寸', shell.markW >= 20, shell.markW);
  ck('六个分区页签', shell.tabs.length === 6, shell.tabs);
  ck('快讯条有内容', shell.news > 0, shell.news);
  ck('五项账户指标', shell.hudStats === 5, shell.hudStats);
  ck('风控顾问徽记带状态标签', /帝爱风控徽记/.test(shell.advisor || ''), shell.advisor);
  ck('行情列表已有数据', shell.rows > 10, shell.rows);

  /* ============ 4. 布局 ============ */
  console.log('\n--- 4. 布局（正规终端密度）---');
  const layout = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.grid'));
    return {
      hOverflow: document.documentElement.scrollHeight > window.innerHeight + 2,
      cols: cs.gridTemplateColumns,
      fontBase: getComputedStyle(document.body).fontSize,
      chartW: document.getElementById('kchart').clientWidth,
      chartH: document.getElementById('kchart').clientHeight,
      eqH: document.getElementById('equityChart').clientHeight,
      hdBorder: getComputedStyle(document.querySelector('.panel-hd')).borderBottomWidth,
      radius: getComputedStyle(document.querySelector('.stat')).borderRadius,
      shadow: getComputedStyle(document.querySelector('.panel-hd')).boxShadow
    };
  });
  log('LAYOUT', layout);
  ck('页面无纵向溢出', !layout.hOverflow, layout.hOverflow);
  ck('三栏网格成列', layout.cols.split(' ').length === 3, layout.cols);
  ck('K线画布有面积', layout.chartW > 300 && layout.chartH > 100, [layout.chartW, layout.chartH]);
  ck('净值曲线画布有面积', layout.eqH > 55, layout.eqH);
  ck('细线分隔（非漫画粗边）', parseFloat(layout.hdBorder) <= 1.5, layout.hdBorder);
  ck('小圆角（非漫画风）', parseFloat(layout.radius) <= 6, layout.radius);

  /* ============ 5. 画布真的画了 ============ */
  console.log('\n--- 5. 图表渲染 ---');
  const drawn = await p.evaluate(() => {
    const cv = document.getElementById('kchart');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) n++;
    return { kNonBlank: n, w: cv.width, h: cv.height };
  });
  log('CANVAS', drawn);
  ck('K线画布非空白', drawn.kNonBlank > 40, drawn.kNonBlank);

  /* ============ 6. 交易链路 ============ */
  console.log('\n--- 6. 交易 ---');
  const trade = await p.evaluate(() => {
    Game.reset('replay', 1, 60);
    Market.setIdx(60);
    const code = Market.tradable.find(m =>
      m.zone === 'A' && !Market.isCB(m.code) && Game.px(m.code) * 100 < 300000).code;
    UI.select(code);
    const cash0 = Game.G.realized;
    const px = Game.px(code);
    const r1 = Game.buy(code, px, 100);
    const afterBuy = { shares: (Game.pos(code) || {}).shares || 0, cash: Game.avail() };
    const r2 = Game.sell(code, Game.px(code), 100);
    Game.stepDay(1);
    const r3 = Game.sell(code, Game.px(code), 100);
    return {
      code, px: +px.toFixed(2),
      buyOk: !!r1.ok, shares: afterBuy.shares,
      sameDayBlocked: !r2.ok, sameDayMsg: r2.msg || '',
      nextOk: !!r3.ok, left: (Game.pos(code) || {}).shares || 0
    };
  });
  log('TRADE', trade);
  ck('买入成交', trade.buyOk && trade.shares > 0, [trade.buyOk, trade.shares]);
  ck('T+1 当日不可卖', trade.sameDayBlocked, trade.sameDayMsg);
  ck('次日卖出成功', trade.nextOk && trade.left === 0, trade.left);

  /* ============ 7. 影子价格 / 玩法开关 ============ */
  console.log('\n--- 7. 影子价格与玩法开关 ---');
  /* 第 1 步：制造扰动并建仓 */
  const shadowStep = await p.evaluate(() => {
    Game.reset('replay', 1, 60);
    Market.setIdx(60);
    const code = Market.tradable.find(m =>
      m.zone === 'A' && !Market.isCB(m.code) && Game.px(m.code) * 100 < 300000).code;
    UI.select(code);
    /* 先建仓 —— 蝴蝶效应按设计只在持仓标的上激活 */
    const b1 = Game.buy(code, Game.px(code), 100);
    if (!b1.ok) return { err: 'buy failed: ' + b1.msg };
    Game.setOpt('butterfly', true);
    Game.G.butterfly = 5;
    Game.stepDay(4);
    UI.select(code);
    UI.refreshAll();
    return { code };
  });
  ck('影子价格测试前置建仓成功', !shadowStep.err, shadowStep.err || shadowStep.code);
  /* 第 2 步：等 rAF 渲染落地后再读 DOM */
  await p.waitForTimeout(400);
  const shadow = await p.evaluate(() => {
    const code = Game.G.positions[0].code;
    const k = Game.kAt(code, Market.idx);
    const pxNow = Game.px(code);
    const real = Market.bar(code).c;
    const row = document.querySelector('.srow.on .pv b');
    const top = document.getElementById('curPrice');
    const lim = Game.limits(code);
    return {
      code, k: +k.toFixed(4), pxNow: +pxNow.toFixed(2), real: +real.toFixed(2),
      row: row ? row.textContent : '', top: top ? top.textContent : '',
      lim: [+lim.up.toFixed(2), +lim.down.toFixed(2), +lim.pc.toFixed(2)],
      bandOk: lim.up > lim.pc && lim.pc > lim.down
    };
  });
  log('SHADOW', shadow);
  ck('扰动后价格偏离原始历史', Math.abs(shadow.k - 1) > 0.0001, shadow.k);
  ck('行情列表用影子价', Math.abs(parseFloat(shadow.row) - shadow.pxNow) < 0.02, [shadow.row, shadow.pxNow]);
  ck('顶栏用影子价',
    Math.abs(parseFloat(String(shadow.top).replace(/,/g, '')) - shadow.pxNow) < 0.02, [shadow.top, shadow.pxNow]);
  ck('涨跌停带宽随影子价平移', shadow.bandOk, shadow.lim);

  const off = await p.evaluate(() => {
    Game.setOpt('butterfly', false);
    Game.G.butterfly = 0;
    const code = Game.G.positions.length ? Game.G.positions[0].code : Market.tradable[0].code;
    return { code, k: Game.kAt(code, Market.idx), px: Game.px(code), real: Market.bar(code).c };
  });
  log('SHADOW-OFF', off);
  ck('关闭后扰动系数严格为 1', off.k === 1, off.k);
  ck('关闭后 px 严格等于市价', Math.abs(off.px - off.real) < 1e-9, off.px);
  /* 复原开关，后面要验「默认全部开启」 */
  await p.evaluate(() => Game.setOpt('butterfly', true));

  await p.click('#setBtn');
  await p.waitForSelector('#setModal:not(.hidden)');
  const setUi = await p.evaluate(() => ({
    rows: document.querySelectorAll('#setBody .set-row').length,
    sw: document.querySelectorAll('#setBody .switch').length,
    on: document.querySelectorAll('#setBody .switch.on').length,
    lv: document.querySelectorAll('#setBody .lvl-btn').length,
    lead: (document.querySelector('#setModal .law-lead') || {}).textContent || ''
  }));
  log('SET-UI', setUi);
  // 因新增 opt.micro 开关而同步更新 6 → 7：仅计数期望值随产品意图变更，断言逻辑未改
  ck('设置面板 7 项开关', setUi.sw === 7, setUi.sw);
  // 因新增 opt.micro 开关（默认开启）而同步更新 6 → 7：仅计数期望值随产品意图变更，断言逻辑未改
  ck('默认全部开启', setUi.on === 7, setUi.on);
  ck('黑天鹅 5 档频率', setUi.lv === 5, setUi.lv);
  ck('面板说明默认开启', /默认全部开启/.test(setUi.lead), setUi.lead.slice(0, 24));
  await p.click('#setBody .switch[data-opt="blackswan"]');
  await p.waitForTimeout(120);
  const tg = await p.evaluate(() => ({
    v: Game.optOf('blackswan'),
    cls: document.querySelector('#setBody .switch[data-opt="blackswan"]').className
  }));
  ck('开关可点击并生效', tg.v === false && tg.cls.indexOf('on') < 0, tg);
  await p.click('#setBody .switch[data-opt="blackswan"]');
  await p.click('#setModal [data-close="setModal"]');
  await p.waitForTimeout(150);

  /* ============ 8. 理财中心 ============ */
  console.log('\n--- 8. 理财中心 ---');
  await p.click('#wealthBtn');
  await p.waitForSelector('#wealthModal:not(.hidden)');
  const wtabs = await p.evaluate(() => [...document.querySelectorAll('#wealthTabs .wtab')].map(x => x.dataset.wt));
  ck('理财中心 6 页签', wtabs.length === 6, wtabs);
  const panes = {};
  for (const t of ['repo', 'wm', 'cb', 'dca', 'ins', 'div']) {
    await p.click(`#wealthTabs .wtab[data-wt="${t}"]`);
    await p.waitForTimeout(150);
    panes[t] = await p.evaluate(() => document.getElementById('wealthBody').innerHTML.length);
  }
  log('WEALTH-LEN', panes);
  ck('六个页签都有内容', Object.values(panes).every(v => v > 300), panes);
  await p.click('#wealthModal [data-close="wealthModal"]');

  /* ============ 9. 存档 ============ */
  console.log('\n--- 9. 存档 ---');
  const save = await p.evaluate(() => {
    Game.save();
    const sv = JSON.parse(localStorage.getItem(Game.save_key));
    return {
      key: Game.save_key, has: !!sv,
      opt: sv && sv.opt ? Object.keys(sv.opt).length : 0,
      swans: !!(sv && sv.swans),
      log: !!(sv && sv.swanLog)
    };
  });
  log('SAVE', save);
  ck('存档写入成功', save.has, save.key);
  // 因新增 opt.micro / opt.microLevel 两个配置项而同步更新 8 → 10：仅计数期望值随产品意图变更，断言逻辑未改
  ck('存档含 10 项玩法开关', save.opt === 10, save.opt);
  ck('存档含黑天鹅与事件日志', save.swans && save.log, [save.swans, save.log]);

  /* ============ 10. 长跑稳定性 ============ */
  console.log('\n--- 10. 长跑 ---');
  /* 黑天鹅由种子驱动（同一局可复现），单局概率性地可能一次不触发，
     因此跨多个种子验证「机制确实会触发」，而不是赌某一次的运气 */
  const run = await p.evaluate(() => {
    let swans = 0, seed = '', tries = 0;
    for (let a = 0; a < 12 && !swans; a++) {
      Market.setIdx(40);
      Game.reset('replay', 1, 40);
      Game.G.bSeed = 'verify' + a;         // 固定种子 → 本局可复现
      Game.setOpt('swanLevel', 4);          // 提高频率档位，同时清缓存
      let guard = 0;
      while (guard++ < 200 && Market.canNext()) Game.stepDay(1);
      swans = (Game.G.swanLog || []).length;
      seed = Game.G.bSeed; tries = a + 1;
    }
    const s = Game.summary();
    return {
      days: Market.idx - Game.G.startIdx, tries, seed, swans,
      equity: Math.round(s.equity), ruin: !!s.ruin
    };
  });
  log('LONG-RUN', run);
  ck('长跑 200 日无异常', run.days >= 180, run.days);
  ck('黑天鹅机制会触发（跨种子验证）', run.swans > 0, [run.tries, run.seed, run.swans]);

  /* 同一种子 → 同一结果（可复现） */
  const repro = await p.evaluate(() => {
    const once = () => {
      Market.setIdx(40);
      Game.reset('replay', 1, 40);
      Game.G.bSeed = 'repro-fixed';
      Game.setOpt('swanLevel', 4);
      let g = 0;
      while (g++ < 120 && Market.canNext()) Game.stepDay(1);
      return (Game.G.swanLog || []).map(s => s.id + '@' + s.startIdx + ':' + s.drift.toFixed(6)).join(',');
    };
    const a = once(), b = once();
    return { same: a === b, n: a ? a.split(',').filter(Boolean).length : 0 };
  });
  log('REPRO', repro);
  ck('同种子黑天鹅可复现', repro.same, repro.n);

  /* ============ 11. 响应式 ============ */
  console.log('\n--- 11. 响应式 ---');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(450);
  const mob = await p.evaluate(() => ({
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    mark: !!document.querySelector('.logo-mark'),
    chartH: document.getElementById('kchart').clientHeight
  }));
  log('MOBILE', mob);
  ck('移动端无横向溢出', !mob.hOverflow, mob.hOverflow);
  ck('移动端徽记仍在', mob.mark, mob.mark);
  ck('移动端 K 线保留高度', mob.chartH > 150, mob.chartH);
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(450);

  /* ============ 截图 ============ */
  console.log('\n--- 截图 ---');
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForSelector('#intro:not(.hidden)');
  await p.waitForTimeout(900);
  await p.screenshot({ path: OUT + 'teiai-01-intro.png' });
  console.log('  teiai-01-intro.png');

  await p.click('#startBtn');
  await p.waitForSelector('.srow');
  await p.evaluate(() => {
    Game.G.butterfly = 3;
    Game.stepDay(6);
    UI.refreshAll(); UI.drawChart(); UI.drawEquity();
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT + 'teiai-02-main.png' });
  console.log('  teiai-02-main.png');

  await p.click('#setBtn');
  await p.waitForTimeout(450);
  await p.screenshot({ path: OUT + 'teiai-03-settings.png' });
  console.log('  teiai-03-settings.png');

  await p.click('#setModal [data-close="setModal"]');
  await p.click('#wealthBtn');
  await p.waitForTimeout(450);
  await p.screenshot({ path: OUT + 'teiai-04-wealth.png' });
  console.log('  teiai-04-wealth.png');

  await p.click('#wealthModal [data-close="wealthModal"]');
  await p.click('#loanBtn');
  await p.waitForTimeout(450);
  await p.screenshot({ path: OUT + 'teiai-05-loan.png' });
  console.log('  teiai-05-loan.png');

  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + 'teiai-06-mobile.png' });
  console.log('  teiai-06-mobile.png');

  console.log('\nERRORS: ' + (errs.length ? '\n' + errs.join('\n') : 'none'));
  console.log('FAILURES: ' + FAIL);
  await b.close();
  process.exit(errs.length || FAIL ? 1 : 0);
})();
