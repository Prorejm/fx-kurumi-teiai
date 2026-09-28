/* ============================================================================
 * micro.js —— 市场微观结构引擎（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * window.Micro · IIFE 单例 · 零依赖 · 零构建 · 全部随机性走 hash01（禁止 Math.random）
 *
 * 阶段：
 *   T02a      = 'skeleton'      仅接线，factor() 恒为 1（零影响）
 *   T02b-CP1  = 'cp1-orderbook' 订单簿 + 5 类代理 + 撮合 + 逐笔 + 分时聚合。
 *                               factor() 仍返回字面量 1 ⇒ 对外价格零影响。
 *   T02b-CP2  = 'cp2-takeover'（本文件当前阶段）
 *              玩家流 → Kyle λ → 引力锚（OU）carry 递推 → 定价接管。
 *              Micro.factor = exp(carry)；**无玩家交易 ⇒ carry≡0 ⇒ factor 精确 === 1**。
 *
 * 契约（架构 §决策2）：
 *   - 以宿主 Game.G（种子/opt/microCarry）与 Market（历史序列）为唯一输入
 *   - 分时序列 = 逐笔成交按分钟聚合（内生涌现，非对历史 bar 的线性/正弦插值）
 *   - carry 的唯一来源是「玩家当日净订单流」；NPC 净流按锚定校准，对 carry 贡献 0
 *   - micro 关闭 ⇒ factor 立即返回 1 ⇒ kAt 逐位回退（P0-C8）
 * ========================================================================== */
window.Micro = (function () {
  'use strict';

  var STAGE = 'cp2-takeover';
  var LEVELS = ['lite', 'std', 'hard'];
  var MINUTES = 240;                 // 交易日分钟数（9:30-11:30 + 13:00-15:00）
  var AGENTS = ['retail', 'hotmoney', 'inst', 'quant', 'mm'];   // mm 最后：库存对冲需读累计净流
  var LAMBDA = 0.0025;               // 内部（可视化）冲击系数，仅决定分时形态尺度

  /* ---- CP2：引力锚（OU）参数表（架构 §决策2 半衰期表）---- */
  var PARAMS = {
    lite: { H: 8,  lam: 0.006 },     // 简化：回归强、接近历史
    std:  { H: 20, lam: 0.010 },     // 标准（默认）
    hard: { H: 40, lam: 0.015 }      // 硬核：回归弱、更独立
  };
  var CAP = 0.5;                     // 对数偏离上限 ±50%（clamp）
  var ADV_REF = 1e8;                 // 流动性修正基准 ADV（元）
  /* 永久冲击「吸收门限」：占 ADV 不足 PERM_MIN 的委托当日即被盘口吸收，不产生**永久**冲击
     （其临时冲击已由 game.js 的 impactSlip / fillPrice 建模）。超过该门限的部分才走平方
     根律：imp = λ·sqrt(max(0, |X|/ADV − PERM_MIN))。取 0.1% —— 对设计验收档位
     （X/ADV = 10%/50%/100%/300%）的影响 < 0.5%，远小于其 dev 阈值余量。 */
  var PERM_MIN = 1e-3;
  var HIST_MAX = 240;                // 每标的最多保留的 carry 历史点（供 K 线回看）

  var cache = {};                    // code@i → dayData（纯派生，可随时丢弃）
  var state = {
    seed: null,
    hot: [],
    pending: {}                      // code → 当日尚未结算的玩家净订单流（元，正=买）
  };

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
  function currentIdx() {
    try { if (window.Market && Market.idx !== undefined) return Market.idx; } catch (e) { /* ignore */ }
    return 0;
  }
  function metaOf(code) {
    try { if (window.Market && Market.metaOf) return Market.metaOf(code); } catch (e) { /* ignore */ }
    return null;
  }

  function enabled() { return optGet('micro', true) !== false; }
  function level() {
    var lv = optGet('microLevel', 'std');
    return LEVELS.indexOf(lv) !== -1 ? lv : 'std';
  }
  function levelParams() { return PARAMS[level()] || PARAMS.std; }

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

  /**
   * 玩家冲击的流动性基准：当日 ADV（**元**）。
   * MetaData.market='cb' ⇒ 每手 10 张，其余每手 100 股。
   */
  function advNotional(code, i) {
    var v = 0;
    try { if (window.Market && Market.avgVol) v = Market.avgVol(code, 20); } catch (e) { /* ignore */ }
    var m = metaOf(code);
    var mult = (m && m.market === 'cb') ? 10 : 100;      // 快照量(手) → 股/张
    var shares = (v > 0 && isFinite(v)) ? v * mult : 0;
    var b = rawAt(code, i);
    var px = (b && b.c > 0) ? b.c : 0;
    if (!(px > 0)) { try { if (window.Market && Market.price) px = Market.price(code); } catch (e) { /* ignore */ } }
    if (!(px > 0)) px = 10;
    if (!(shares > 0)) shares = ((b && b.v) ? b.v : 1e5) * mult;
    return shares * px;
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
    if (i === undefined) i = currentIdx();
    var key = code + '@' + i;
    var hit = cache[key];
    if (hit) return hit;
    var d = simulate(code, i);
    cache[key] = d;
    return d;
  }

  /* ------------------------------------------------------------ 引力锚（OU）定价 */
  /*   ln P = ln A + carry ；A = raw.c × bfactorAt × swanFactor（由 game.js 组合）
   *   carry_i = clamp( carry_{i-1}·exp(−θ_eff) + imp_i , ±CAP )
   *   imp_i   = Kyle：λ_sqrt(level)·sign(flow_i)·sqrt(|flow_i|/ADV)
   *   θ_eff   = (ln2/H)·g_liq(ADV)·h(|carry|)
   *   ---- carry 的唯一来源是玩家净订单流；NPC 净流按锚定校准，贡献 0 ----
   */

  /** carry 持久层：G.microCarry = { code: [[i,carry], …] }（进存档，可复现玩家拉抬） */
  function carryMap() {
    try {
      if (window.Game && Game.G) {
        if (!Game.G.microCarry || typeof Game.G.microCarry !== 'object') Game.G.microCarry = {};
        return Game.G.microCarry;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 第 i 日适用的 carry（取最近一个 ≤ i 的历史点；无则 0）。 */
  function carryAt(code, i) {
    var m = carryMap();
    if (!m) return 0;
    var h = m[code];
    if (!h || !h.length) return 0;
    var cv = 0;
    for (var k = 0; k < h.length; k++) {
      if (h[k][0] <= i) cv = h[k][1];
      else break;
    }
    return cv;
  }

  /** 当前（最新）carry；无玩家交易 ⇒ 0。 */
  function carry(code) {
    var m = carryMap();
    var h = m && m[code];
    return (h && h.length) ? h[h.length - 1][1] : 0;
  }

  /** 流动性修正 g_liq：ADV 越大回归越强（上限 1.6 / 下限 0.6）。 */
  function gLiq(advN) {
    return clamp(0.6 + 0.4 * Math.log10(Math.max(1, advN) / ADV_REF), 0.6, 1.6);
  }

  /** 偏离放大回归强度 h(|carry|)：偏离越大回归越强（上限 6）。 */
  function hOf(carryVal, sigma) {
    var s = (sigma > 0) ? sigma : 0.015;
    return clamp(1 + Math.abs(carryVal) / s, 1, 6);
  }

  /** 有效回归速率 θ_eff = (ln2/H)·g_liq·h(|carry|)。 */
  function thetaEff(code, i, sigma, carryVal) {
    var P = levelParams();
    return (Math.LN2 / P.H) * gLiq(advNotional(code, i)) * hOf(carryVal, sigma);
  }

  /**
   * Kyle λ 冲击项（对数）：imp = λ·sign(X)·sqrt(|X|/ADV)。
   * 采用「吸收门限」形式：先扣掉被盘口当日吸收的 PERM_MIN·ADV，剩余部分才产生永久冲击。
   * 于是小额委托（如 1 手）严格 imp === 0 ⇒ carry≡0 ⇒ factor 精确 === 1（IEEE 精确回退）。
   */
  function kyleImp(code, i, flowNotional) {
    if (!flowNotional || !isFinite(flowNotional)) return 0;
    var adv = advNotional(code, i);
    if (!(adv > 0)) return 0;
    var P = levelParams();
    var part = Math.abs(flowNotional) / adv - PERM_MIN;
    if (part <= 0) return 0;                    // 被吸收 ⇒ 无永久冲击（严格零）
    return P.lam * sign(flowNotional) * Math.sqrt(part);
  }

  /**
   * 订单流乘子。
   * - micro 关闭 ⇒ 立即返回 1（逐位回退）
   * - 无玩家冲击（carry 与当日 pending 皆 0）⇒ 精确返回字面量 1（exp(0)===1）
   * - 否则 ⇒ exp(carry)
   */
  function factor(code, i) {
    if (!enabled()) return 1;
    var idx = currentIdx();
    var ii = (i === undefined) ? idx : i;
    var c = carryAt(code, ii);
    // 当前日叠加「尚未结算」的玩家净流冲击，使玩家当日即看到价格反应
    if (ii === idx) {
      var pend = state.pending[code];
      if (pend) c += kyleImp(code, ii, pend);
    }
    if (c === 0) return 1;
    return Math.exp(c);
  }

  /* ------------------------------------------------------------ 公共读取 */

  /** 分时序列（= 逐笔按分钟聚合，内生涌现）。 */
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

  /** 引力锚（原始收盘锚 raw.c）；带 microFactor 的最终价由 game.js 组合。 */
  function anchor(code, i) {
    var d = dayData(code, i);
    return d.prevClose || 0;
  }

  /* ------------------------------------------------------------ 玩家流 & 逐日递推 */

  /**
   * 登记玩家当日净订单流（元，正=买/负=卖）。
   * micro 关闭时整段短路（A4：关闭 ⇒ dev==0）。
   * @returns {number} 当日截至目前的累计净流
   */
  function applyPlayerFlow(G, code, X) {
    if (!enabled()) return 0;
    if (!code || !X || !isFinite(X) || X === 0) return 0;
    state.pending[code] = (state.pending[code] || 0) + X;
    return state.pending[code];
  }

  /**
   * 逐日推进（在 game.js stepDay 中于 Market.next(1) 之后调用）：
   * 对每个有过 carry / 当日有玩家流的标的，做一次 OU 递推并落盘到 G.microCarry。
   */
  function step(G, i) {
    if (!enabled()) { state.pending = {}; return; }
    var m = carryMap();
    if (!m) return;
    var idx = (i === undefined) ? currentIdx() : i;

    var codes = {};
    for (var c1 in state.pending) codes[c1] = 1;
    for (var c2 in m) codes[c2] = 1;

    for (var code in codes) {
      var prev = carry(code);
      var flow = state.pending[code] || 0;
      if (prev === 0 && flow === 0) continue;
      var sigma = dailyVol(code, idx);
      var th = thetaEff(code, idx, sigma, prev);
      var imp = kyleImp(code, idx, flow);
      var next = clamp(prev * Math.exp(-th) + imp, -CAP, CAP);
      if (!isFinite(next)) next = prev;
      var h = m[code] || (m[code] = []);
      h.push([idx, next]);
      if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);
    }
    state.pending = {};
  }

  /* ------------------------------------------------------------ 生命周期 */

  function reset(seed) {
    state.seed = (seed === undefined) ? null : seed;
    state.hot = [];
    state.pending = {};
    cache = {};
    return true;
  }
  function getState() {
    var m = carryMap();
    var n = 0;
    for (var k in (m || {})) n++;
    return {
      stage: STAGE, enabled: enabled(), level: level(), seed: state.seed,
      hot: state.hot.slice(), cacheSize: Object.keys(cache).length,
      minutesPerDay: MINUTES, agents: AGENTS.slice(),
      carryCodes: n, pendingCodes: Object.keys(state.pending).length
    };
  }
  function setOpt(key, val) {
    if (key === 'micro' || key === 'microLevel') {
      cache = {};                                  // 档位/开关变化 → 丢弃派生缓存
      if (key === 'micro' && val === false) state.pending = {};   // 关闭即清当日待结算流
    }
    return true;
  }
  function setHot(codes) {
    state.hot = (codes || []).slice(0, 8);
    return state.hot.length;
  }

  function init(G, deps) { return true; }

  return {
    STAGE: STAGE,
    LEVELS: LEVELS,
    MINUTES_PER_DAY: MINUTES,
    AGENT_NAMES: AGENTS.slice(),
    PARAMS: PARAMS,
    CAP: CAP,
    PERM_MIN: PERM_MIN,
    /* 配置 */
    enabled: enabled, level: level,
    /* 定价 */
    factor: factor, carry: carry, carryAt: carryAt,
    /* 玩家流 */
    applyPlayerFlow: applyPlayerFlow,
    /* 生命周期 */
    reset: reset, getState: getState, setOpt: setOpt, setHot: setHot,
    init: init, step: step,
    /* 微观读取 */
    minute: minute, ticks: ticks, book: book, agents: agents, anchor: anchor,
    /* 派生量（供测试/UI 复用同一口径） */
    advNotional: advNotional, kyleImp: kyleImp, thetaEff: thetaEff
  };
})();
