/* ============================================================================
 * micro.js —— 市场微观结构引擎（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * window.Micro · IIFE 单例 · 零依赖 · 零构建 · 全部随机性走 hash01（禁止 Math.random）
 *
 * 阶段：
 *   T02a  = 'skeleton'   仅接线，factor() 恒为 1（零影响）
 *   T02b-CP1 本文件当前阶段：订单簿 + 5 类代理 + 撮合 + 逐笔 + 分时聚合。
 *            **factor() 仍返回字面量 1** ⇒ 对外价格零影响（kAt 逐位不变）。
 *            载入期与调用期均不修改 Game.G / Market 的任何状态（只做纯计算 + 缓存）。
 *
 * 契约（架构 §决策2）：
 *   - 以宿主 Game.G（种子/opt）与 Market（历史序列）为唯一输入，不私有可变价格状态
 *   - 分时序列 = 逐笔成交按分钟聚合（内生涌现，非对历史 bar 的线性/正弦插值）
 *   - NPC 净流驱动日内路径；日终校准与玩家冲击将在 CP2 接入（届时 factor → exp(carry)）
 * ========================================================================== */
window.Micro = (function () {
  'use strict';

  var STAGE = 'cp1-orderbook';
  var LEVELS = ['lite', 'std', 'hard'];
  var MINUTES = 240;                 // 交易日分钟数（9:30-11:30 + 13:00-15:00）
  var AGENTS = ['retail', 'hotmoney', 'inst', 'quant', 'mm'];   // mm 最后：库存对冲需读累计净流
  var LAMBDA = 0.0025;               // 内部（可视化）冲击系数，仅决定分时形态尺度

  var cache = {};                    // code@i → dayData（纯派生，可随时丢弃）
  var state = { seed: null, hot: [] };

  /* ------------------------------------------------------------ 确定性随机 */

  /** FNV-1a + murmur3 fmix32（与 Game.hash01 同构；Game 未就绪时本地兜底）。 */
  function hash01(str) {
    if (window.Game && typeof Game.hash01 === 'function') return Game.hash01(str);
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

  /* ------------------------------------------------------------ 宿主配置读取 */

  function optGet(key, dflt) {
    try {
      if (window.Game && Game.G && Game.G.opt && Game.G.opt[key] !== undefined) return Game.G.opt[key];
    } catch (e) { /* ignore */ }
    return dflt;
  }
  function seedOf() {
    try { if (window.Game && Game.G && Game.G.bSeed) return Game.G.bSeed; } catch (e) { /* ignore */ }
    return state.seed || '0';
  }

  function enabled() { return optGet('micro', true) !== false; }
  function level() {
    var lv = optGet('microLevel', 'std');
    return LEVELS.indexOf(lv) !== -1 ? lv : 'std';
  }

  /* ------------------------------------------------------------ 派生参数 */

  /** 20 日均成交量（股/份，median）；不足时回落当日量，再回落常量。 */
  function advShares(code, i) {
    var v = 0;
    try { if (window.Market && Market.avgVol) v = Market.avgVol(code, 20); } catch (e) { /* ignore */ }
    if (!v || !isFinite(v) || v <= 0) {
      var b = rawAt(code, i);
      v = (b && b.v) || 1e5;
    }
    return v;
  }

  /** 近 20 日日收益标准差（日波动率）；不足 5 日回落 1.5%。 */
  function dailyVol(code, i) {
    var rs = [];
    var start = Math.max(1, i - 20);
    for (var k = start; k <= i; k++) {
      var a = rawAt(code, k - 1), b = rawAt(code, k);
      if (a && b && a.c > 0) rs.push(b.c / a.c - 1);
    }
    if (rs.length < 5) return 0.015;
    var mean = 0;
    for (var j = 0; j < rs.length; j++) mean += rs[j];
    mean /= rs.length;
    var vv = 0;
    for (var j2 = 0; j2 < rs.length; j2++) vv += (rs[j2] - mean) * (rs[j2] - mean);
    vv /= rs.length;
    return clamp(Math.sqrt(vv), 0.006, 0.09);
  }

  function rawAt(code, i) {
    try { if (window.Market && Market.raw) return Market.raw(code, i); } catch (e) { /* ignore */ }
    return null;
  }

  /* ------------------------------------------------------------ 代理行为（最小可用版） */

  /**
   * 单个代理在第 m 分钟的净委托量（股，正=买）。
   * @returns {number}
   */
  function agentFlow(a, seed, code, i, m, mom, cumNet, part) {
    var base = seed + '#agent#' + a + '#' + code + '#' + i + '#' + m;
    var sgn = sign(mom) || 1;
    if (a === 'retail') {
      // 散户：羊群（追随近期动量），小单
      var u = hash01(base + '#u'), v = hash01(base + '#v');
      var dir = (u < 0.62) ? sgn : -sgn;
      var mag = part * 0.12 * (0.4 + 1.2 * v);
      return dir * mag;
    }
    if (a === 'hotmoney') {
      // 游资：低频脉冲，大单，偏动量
      if (hash01(base + '#on') > 0.12) return 0;
      var d = (hash01(base + '#d') < 0.55) ? sgn : (hash01(base + '#d2') < 0.5 ? 1 : -1);
      var s = hash01(base + '#s');
      return (d || 1) * part * 1.3 * (0.5 + 1.5 * s);
    }
    if (a === 'inst') {
      // 机构：稳定分批 + 反向回归（VWAP 意味）
      var si = hash01(base + '#s');
      return (-sgn) * part * 0.30 * (0.6 + 0.8 * si);
    }
    if (a === 'quant') {
      // 量化：高频小单，动量与反转混合
      var uq = hash01(base + '#u');
      var sq = hash01(base + '#s');
      var dq = (uq < 0.5) ? sgn : -sgn;
      return (dq || 1) * part * 0.16 * (0.3 + 1.0 * sq);
    }
    // 做市商：库存偏好 —— 反向对冲累计净流
    var inv = sign(cumNet);
    var sm = hash01(base + '#s');
    return (-inv) * part * 0.10 * (0.4 + 0.8 * sm);
  }

  function minuteLabel(m) {
    var total = (m < 120) ? (9 * 60 + 30 + m) : (13 * 60 + (m - 120));
    var h = Math.floor(total / 60), mm = total % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /* ------------------------------------------------------------ 日内模拟 */

  /** 运行(code, i)的确定性日内模拟，产出逐笔 + 分时 + 代理净流入。 */
  function simulate(code, i) {
    var out = { code: code, i: i, ticks: [], minutes: [], agents: [], mid: 0, spread: 0,
      prevClose: 0, open: 0, sigma: 0.015, adv: 0 };
    var b = rawAt(code, i);
    if (!b) return out;

    var pc = 0;
    try { if (window.Market && Market.prevClose) pc = Market.prevClose(code, i); } catch (e) { /* ignore */ }
    if (!pc || pc <= 0) pc = b.c;
    var open = b.o > 0 ? b.o : pc;
    var sigma = dailyVol(code, i);
    var sigmaMin = sigma / Math.sqrt(MINUTES);
    var adv = advShares(code, i);
    var part = Math.max(1, adv / MINUTES);
    var seed = seedOf();

    var mid = open, cumNet = 0, mom = 0;
    var agg = {};
    AGENTS.forEach(function (a) { agg[a] = { net: 0, amount: 0, orders: 0 }; });

    for (var m = 0; m < MINUTES; m++) {
      var mo = mid, mh = -Infinity, ml = Infinity, mv = 0, first = null, last = null;
      for (var ai = 0; ai < AGENTS.length; ai++) {
        var a = AGENTS[ai];
        var flow = agentFlow(a, seed, code, i, m, mom, cumNet, part);
        if (!flow) continue;
        var dln = clamp(LAMBDA * flow / part, -0.01, 0.01);
        mid = mid * Math.exp(dln);
        cumNet += flow;
        var noise = (hash01(seed + '#px#' + code + '#' + i + '#' + m + '#' + a) - 0.5) * sigmaMin * 0.4;
        var exec = Math.max(0.01, round2(mid * (1 + noise)));
        var size = Math.max(1, Math.round(Math.abs(flow)));
        var side = flow >= 0 ? 'buy' : 'sell';
        out.ticks.push({ m: m, t: minuteLabel(m), price: exec, size: size, side: side, agent: a });
        agg[a].net += flow; agg[a].amount += flow * exec; agg[a].orders++;
        if (first === null) first = exec;
        last = exec;
        if (exec > mh) mh = exec;
        if (exec < ml) ml = exec;
        mv += size;
      }
      if (first === null) { first = last = mo; mh = ml = mo; }
      out.minutes.push({ m: m, t: minuteLabel(m), o: first, h: mh, l: ml, c: last, v: mv });
      mom = 0.7 * mom + 0.3 * ((last - mo) / (mo || 1));
    }

    out.mid = mid;
    out.prevClose = pc;
    out.open = open;
    out.sigma = sigma;
    out.adv = adv;
    out.spread = mid * Math.max(0.0005, sigma * 0.12);
    out.agents = AGENTS.map(function (a) {
      var g = agg[a];
      return { name: a, net: Math.round(g.net), amount: g.amount, orders: g.orders };
    });
    return out;
  }

  function dayData(code, i) {
    if (i === undefined) {
      try { i = window.Market ? Market.idx : 0; } catch (e) { i = 0; }
    }
    var key = code + '@' + i;
    var hit = cache[key];
    if (hit) return hit;
    var d = simulate(code, i);
    cache[key] = d;
    return d;
  }

  /* ------------------------------------------------------------ 定价接口（CP1：仍为零影响） */

  /** 订单流乘子。CP1 仍返回字面量 1 ⇒ kAt 逐位不变；CP2 起返回 exp(carry)。 */
  function factor(code, i) { return 1; }

  /** 引力锚累积偏离。CP1 恒为 0。 */
  function carry(code) { return 0; }

  /* ------------------------------------------------------------ 公共读取（CP1 新增） */

  /** 分时序列（= 逐笔按分钟聚合）。 */
  function minute(code, i) { return dayData(code, i).minutes; }

  /** 逐笔成交（tick prints）。 */
  function ticks(code, i) { return dayData(code, i).ticks; }

  /** 盘口五档快照。 */
  function book(code, i) {
    var d = dayData(code, i);
    if (!d.mid) return { bids: [], asks: [], spread: 0, mid: 0 };
    var stepP = d.mid * Math.max(0.0004, d.sigma * 0.08);
    var depth = Math.max(1, Math.round((d.adv / MINUTES) * 0.6));
    var seed = seedOf();
    var bids = [], asks = [];
    for (var k = 1; k <= 5; k++) {
      var qb = Math.round(depth * (1 + 0.5 * k) * (0.7 + 0.6 * hash01(seed + '#bk#' + code + '#' + i + '#b' + k)));
      var qa = Math.round(depth * (1 + 0.5 * k) * (0.7 + 0.6 * hash01(seed + '#bk#' + code + '#' + i + '#a' + k)));
      bids.push({ price: round2(d.mid - k * stepP), size: Math.max(1, qb) });
      asks.push({ price: round2(d.mid + k * stepP), size: Math.max(1, qa) });
    }
    return { bids: bids, asks: asks, spread: round2(2 * stepP), mid: round2(d.mid) };
  }

  /** 5 类代理当日净流入（股 + 金额）。 */
  function agents(code, i) { return dayData(code, i).agents; }

  /** 引力锚（CP1 占位：返回当日参考锚价 prevClose）。 */
  function anchor(code, i) {
    var d = dayData(code, i);
    return d.prevClose || 0;
  }

  /* ------------------------------------------------------------ 生命周期 */

  function reset(seed) {
    state.seed = (seed === undefined) ? null : seed;
    state.hot = [];
    cache = {};
    return true;
  }
  function getState() {
    return {
      stage: STAGE, enabled: enabled(), level: level(), seed: state.seed,
      hot: state.hot.slice(), cacheSize: Object.keys(cache).length,
      minutesPerDay: MINUTES, agents: AGENTS.slice()
    };
  }
  function setOpt(key, val) {
    if (key === 'micro' || key === 'microLevel') cache = {};   // 档位/开关变化 → 丢弃派生缓存
    return true;
  }
  function setHot(codes) {
    state.hot = (codes || []).slice(0, 8);
    return state.hot.length;
  }

  /** 逐日推进（CP1：惰性计算，不预计算；正式热集推进在 CP3）。 */
  function init(G, deps) { return true; }
  function step(G, i) { /* CP1: 惰性；不做急切计算，零额外开销 */ }

  /* CP2 预留 */
  function applyPlayerFlow(G, code, X) { return 0; }

  return {
    STAGE: STAGE,
    LEVELS: LEVELS,
    MINUTES_PER_DAY: MINUTES,
    AGENT_NAMES: AGENTS.slice(),
    /* 配置 */
    enabled: enabled, level: level,
    /* 定价 */
    factor: factor, carry: carry,
    /* 生命周期 */
    reset: reset, getState: getState, setOpt: setOpt, setHot: setHot,
    init: init, step: step,
    /* 微观读取 */
    minute: minute, ticks: ticks, book: book, agents: agents, anchor: anchor,
    /* CP2 预留 */
    applyPlayerFlow: applyPlayerFlow
  };
})();
