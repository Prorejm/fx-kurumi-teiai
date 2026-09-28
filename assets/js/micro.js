/* ============================================================================
 * micro.js —— 市场微观结构引擎（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * window.Micro · IIFE 单例 · 零依赖 · 零构建 · 全部随机性走 hash01（禁止 Math.random）
 *
 * 阶段：
 *   T02a      = 'skeleton'      仅接线，factor() 恒为 1（零影响）
 *   T02b-CP1  = 'cp1-orderbook' 订单簿 + 5 类代理 + 撮合 + 逐笔 + 分时聚合
 *   T02b-CP2  = 'cp2-takeover'  玩家流 → Kyle λ → 引力锚(OU) carry → 定价接管
 *   T02b-CP3  = 'cp3-backlash'（本文件当前阶段）
 *              · g_liq 夹到 [0.75, 1.333]，令半衰期带宽 [15,40] 恒成立
 *              · 收盘集合竞价校准：分时末点收敛到当日收盘（锚 A），成交量守恒不变
 *              · 跟风放大：散户跟随玩家净流，把冲击放大到可感知量级
 *              · 5 类代理精细化：处置效应 / 隔日了结 / VWAP 分批 / 双边做市 / 高频反转
 *              · 反噬链：获利盘涌出 → 龙虎榜 / 异常波动问询 / 限制交易
 *              · 性能分层：热集完整簿 / 轻量净流 / 其余懒计算
 *
 * 契约（架构 §决策2）：
 *   - 以宿主 Game.G（种子/opt/microCarry）与 Market（历史序列）为唯一输入
 *   - 分时序列 = 逐笔成交按分钟聚合（内生涌现，非对历史 bar 的线性/正弦插值）
 *   - carry 的唯一来源是「玩家当日净订单流」；NPC 净流按锚定校准，对 carry 贡献 0
 *   - micro 关闭 ⇒ factor 立即返回 1 ⇒ kAt 逐位回退（P0-C8）
 * ========================================================================== */
window.Micro = (function () {
  'use strict';

  var STAGE = 'cp3-backlash';
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
  var HIST_MAX = 240;                // 每标的最多保留的 carry 历史点（供 K 线回看）

  /* 永久冲击「吸收门限」。
     永久冲击 vs 瞬时冲击（permanent vs transient impact）是市场微观结构的标准二分：
     小额委托被盘口吸收、流动性回补后价格回归，只留下**瞬时成本**——而瞬时成本已由
     game.js 的 impactSlip / fillPrice 建模，再叠加一次永久冲击即为**重复计价**。
     故占 ADV 不足 PERM_MIN 的委托不留永久 carry，只走：
         imp = λ·sqrt(max(0, |X|/ADV − PERM_MIN))
     取 0.1% —— 对设计验收档位（X/ADV = 10%/50%/100%/300%）的影响 < 0.5%。 */
  var PERM_MIN = 1e-3;

  /* ---- CP3-0：流动性修正夹逼，令半衰期带宽 [15,40] 恒成立 ----
     实测半衰期 ≈ H / g_liq（θ_eff = (ln2/H)·g_liq·h）。若不夹，ADV > 6.8e9 元的超大盘
     g_liq > 1.333 ⇒ 标准档半衰期 < 15 日，跌出设计带宽（这是迟早会触发的）。
     夹到 [0.75, 1.333] 后：标准档 H=20 ⇒ 半衰期恒 ∈ [15.0, 26.7] 日。 */
  var G_LIQ_MIN = 0.75;
  var G_LIQ_MAX = 1.333;

  /* ---- CP3-1：收盘集合竞价窗口（末端对冲，把日内净流残差归零）---- */
  var CLOSE_WIN = 30;                // 收盘前 30 分钟为集合竞价校准窗口

  /* ---- CP3-4：跟风放大（玩家「我能拉股票」的手感来源）----
     现实中游资不是靠自有资金拉票，而是靠跟风盘放大。故在自有冲击之上叠加跟风倍数：
         imp_total = imp_own × (1 + HERD_GAIN[level] × ignite)
     点燃度 ignite 随「超出吸收门限的参与率」线性上升，IGNITE_REF 处完全点燃。
     满点燃时总放大 = 3x(简化) / 5x(标准) / 7x(硬核)。 */
  var IGNITE_REF = 2e-3;             // 参与率（扣掉吸收门限后）达 0.2% 即完全点燃
  var HERD_GAIN = { lite: 2.0, std: 4.0, hard: 6.0 };

  /* ---- CP3-4：反噬链 ---- */
  var PROFIT_TAKE = 0.015;           // 偏离超过 1.5% 后获利盘开始涌出
  var PROFIT_TAKE_K = 0.5;           // 获利盘涌出强度
  var EVT_TIGER = 0.20;              // 龙虎榜：单日净流 > 20% × ADV
  var EVT_ABNORMAL = 0.07;           // 异常波动问询：单日价格冲击 > 7%
  var RESTRICT_FLOW = 0.50;          // 限制交易触发线：单日净流 > 50% × ADV
  var RESTRICT_N = 2;                // RESTRICT_SPAN 个交易日内 2 次超限 ⇒ 限制交易
  var RESTRICT_SPAN = 10;
  var RESTRICT_DAYS = 5;             // 限制交易持续 5 个交易日

  var cache = {};                    // code@i → dayData（纯派生，可随时丢弃）
  var state = {
    seed: null,
    hot: [],                         // 热集（≤8）：完整订单簿，逐日预计算
    watch: [],                       // 轻量集（≤50）：只算净流 + Kyle 出清
    pending: {},                     // code → 当日尚未结算的玩家净订单流（元，正=买）
    events: [],                      // 反噬链事件（game.js 经 takeEvents() 取走并写日志）
    restrict: {},                    // code → 限制交易解禁日 idx
    restrictLog: {},                 // code → [[idx, |净流|/ADV], …] 超限记录
    herd: {}                         // code → 最近一次跟风放大倍数（供 UI 展示）
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
  function herdGain() {
    var g = HERD_GAIN[level()];
    return (g === undefined) ? HERD_GAIN.std : g;
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

  /* ------------------------------------------------------------ 玩家信号 */

  /**
   * 玩家净流的「参与率」（带符号，clamp ±1）——散户跟风的信号源。
   * 未结算的当日净流 + 已沉淀的 carry 折算回当量净流。
   */
  function playerSignal(code, i) {
    var adv = advNotional(code, i);
    if (!(adv > 0)) return 0;
    var pend = state.pending[code] || 0;
    var eq = carryAt(code, i) * Math.max(1, adv);   // carry 折算成当量净流
    return clamp((pend + eq) / adv, -1, 1);
  }

  /* ------------------------------------------------------------ 5 类代理（CP3 精细化） */

  /**
   * 单个代理在第 m 分钟的净委托量（股，正=买）。
   * ctx = { mom, cumNet, part, mid, refPrice, pSig, sigmaMin }
   */
  function agentFlow(a, seed, code, i, m, ctx) {
    var base = seed + '#agent#' + a + '#' + code + '#' + i + '#' + m;
    var sgn = sign(ctx.mom) || 1;
    var part = ctx.part;

    if (a === 'retail') {
      /* 散户：羊群（追随玩家净流 / 近期动量）+ 处置效应（浮盈就跑、浮亏死扛） */
      var u = hash01(base + '#u'), v = hash01(base + '#v');
      // 跟风：玩家参与率越高，散户方向越一致（跟随概率 0.5 → 0.85）
      var herdP = 0.5 + Math.min(0.35, Math.abs(ctx.pSig) * 3);
      var dir = (u < herdP) ? sgn : -sgn;
      // 处置效应：以昨收为参考价
      var pnl = ctx.refPrice > 0 ? (ctx.mid - ctx.refPrice) / ctx.refPrice : 0;
      if (pnl > 0.004 && hash01(base + '#disp') < 0.35) dir = -1;                // 浮盈倾向了结
      else if (pnl < -0.004 && dir < 0 && hash01(base + '#dl') < 0.45) dir = 1;  // 浮亏死扛（不愿割）
      var mag = part * 0.12 * (0.4 + 1.2 * v) * (1 + Math.abs(ctx.pSig) * 2);
      return dir * mag;
    }
    if (a === 'hotmoney') {
      /* 游资：低频脉冲、大单、偏动量；尾盘隔日了结（昨日的仓今日平） */
      if (hash01(base + '#on') > 0.12) {
        // 收盘集合竞价窗口内：隔日了结，反向平掉昨日脉冲
        if (m >= MINUTES - CLOSE_WIN && hash01(base + '#unw') < 0.35) {
          return (-sgn) * part * 0.9 * (0.5 + hash01(base + '#uw'));
        }
        return 0;
      }
      var d = (hash01(base + '#d') < 0.55) ? sgn : (hash01(base + '#d2') < 0.5 ? 1 : -1);
      var s = hash01(base + '#s');
      return (d || 1) * part * 1.3 * (0.5 + 1.5 * s);
    }
    if (a === 'inst') {
      /* 机构：VWAP 分批（日内均匀、越晚越轻）+ 反向回归 */
      var slice = 1.6 - 0.6 * (m / MINUTES);
      var si = hash01(base + '#s');
      return (-sgn) * part * 0.30 * slice * (0.6 + 0.8 * si);
    }
    if (a === 'quant') {
      /* 量化：高频小单，动量与反转混合；波动越大越活跃 */
      var uq = hash01(base + '#u');
      var sq = hash01(base + '#s');
      var dq = (uq < 0.5) ? sgn : -sgn;
      var act = 1 + Math.min(1.5, ctx.sigmaMin / 0.002);
      return (dq || 1) * part * 0.16 * act * (0.3 + 1.0 * sq);
    }
    /* 做市商：双边报价 + 库存偏好反向对冲；波动越大越保守（价差放大 ⇒ 对冲力度下降） */
    var inv = sign(ctx.cumNet);
    var sm = hash01(base + '#s');
    var widen = 1 / (1 + Math.min(1.5, ctx.sigmaMin / 0.002));
    return (-inv) * part * 0.10 * widen * (0.4 + 0.8 * sm);
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
      prevClose: 0, open: 0, sigma: 0.015, adv: 0, close: 0 };
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
    var pSig = playerSignal(code, i);

    var mid = open, cumNet = 0, mom = 0;
    var ctx = { mom: 0, cumNet: 0, part: part, mid: open, refPrice: pc,
      pSig: pSig, sigmaMin: sigmaMin };
    var agg = {};
    AGENTS.forEach(function (a) { agg[a] = { net: 0, amount: 0, orders: 0 }; });

    for (var m = 0; m < MINUTES; m++) {
      var mo = mid, mh = -Infinity, ml = Infinity, mv = 0, first = null, last = null;
      ctx.mom = mom; ctx.cumNet = cumNet; ctx.mid = mid;
      for (var ai = 0; ai < AGENTS.length; ai++) {
        var a = AGENTS[ai];
        var flow = agentFlow(a, seed, code, i, m, ctx);
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
        mv += size;               // 成交量守恒：逐笔 size 之和 = 分钟量（CP1 已验收）
      }
      if (first === null) { first = last = mo; mh = ml = mo; }
      out.minutes.push({ m: m, t: minuteLabel(m), o: first, h: mh, l: ml, c: last, v: mv });
      mom = 0.7 * mom + 0.3 * ((last - mo) / (mo || 1));
    }

    /* ---- CP3-1 收盘集合竞价校准 ----
       日内路径完全由撮合内生涌现；只在收盘前 CLOSE_WIN 分钟施加一段末端对冲（集合竞价），
       把日内净流残差归零 ⇒ 分时末点严格收敛到当日收盘（锚 A = raw.c）。
       成交量字段一律不动 ⇒ volTick === volMinute 守恒不变。 */
    var A = (b.c > 0) ? b.c : 0;
    var lastC = out.minutes.length ? out.minutes[out.minutes.length - 1].c : 0;
    if (A > 0 && lastC > 0) {
      var drift = Math.log(A / lastC);
      var w0 = Math.max(0, MINUTES - CLOSE_WIN);
      for (var mi = 0; mi < out.minutes.length; mi++) {
        var mm2 = out.minutes[mi];
        var f = (mm2.m < w0) ? 1 : Math.exp(drift * (mm2.m - w0 + 1) / CLOSE_WIN);
        if (f === 1) continue;
        mm2.o = round2(mm2.o * f);
        mm2.h = round2(mm2.h * f);
        mm2.l = round2(mm2.l * f);
        mm2.c = round2(mm2.c * f);
      }
      for (var ti = 0; ti < out.ticks.length; ti++) {
        var tk = out.ticks[ti];
        var ft = (tk.m < w0) ? 1 : Math.exp(drift * (tk.m - w0 + 1) / CLOSE_WIN);
        if (ft === 1) continue;
        tk.price = Math.max(0.01, round2(tk.price * ft));
      }
      mid = mid * Math.exp(drift);
    }

    out.mid = mid;
    out.close = A;
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
   *   imp_i   = Kyle λ × 跟风放大：λ·sqrt(max(0,|X|/ADV − PERM_MIN)) × (1 + HERD_GAIN·ignite)
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

  /** 流动性修正 g_liq：ADV 越大回归越强。CP3-0：夹到 [0.75, 1.333] 令半衰期带宽恒成立。 */
  function gLiq(advN) {
    return clamp(0.6 + 0.4 * Math.log10(Math.max(1, advN) / ADV_REF), G_LIQ_MIN, G_LIQ_MAX);
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

  /** Kyle λ 冲击项（对数，仅自有冲击）：imp = λ·sqrt(max(0, |X|/ADV − PERM_MIN))。 */
  function kyleImp(code, i, flowNotional) {
    if (!flowNotional || !isFinite(flowNotional)) return 0;
    var adv = advNotional(code, i);
    if (!(adv > 0)) return 0;
    var P = levelParams();
    var part = Math.abs(flowNotional) / adv - PERM_MIN;
    if (part <= 0) return 0;                    // 被盘口吸收 ⇒ 无永久冲击（严格零）
    return P.lam * sign(flowNotional) * Math.sqrt(part);
  }

  /**
   * 跟风放大倍数（CP3-4）：散户跟随玩家净流，把冲击放大到可感知量级。
   * ignite 随「超出吸收门限的参与率」线性上升，IGNITE_REF 处完全点燃。
   * @returns {number} ≥ 1
   */
  function herdAmp(code, i, flowNotional) {
    if (!flowNotional || !isFinite(flowNotional)) return 1;
    var adv = advNotional(code, i);
    if (!(adv > 0)) return 1;
    var partEff = Math.abs(flowNotional) / adv - PERM_MIN;
    if (partEff <= 0) return 1;                 // 被吸收 ⇒ 无跟风可点燃
    var ignite = clamp(partEff / IGNITE_REF, 0, 1);
    return 1 + herdGain() * ignite;
  }

  /** 含跟风放大的冲击项（对数）。 */
  function impWith(code, i, flowNotional) {
    var own = kyleImp(code, i, flowNotional);
    if (own === 0) return 0;
    return own * herdAmp(code, i, flowNotional);
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
    // 当前日叠加「尚未结算」的玩家净流冲击（含跟风放大），使玩家当日即看到价格反应
    if (ii === idx) {
      var pend = state.pending[code];
      if (pend) c += impWith(code, ii, pend);
    }
    if (c === 0) return 1;
    return Math.exp(c);
  }

  /* ------------------------------------------------------------ 公共读取 */

  /** 分时序列（= 逐笔按分钟聚合，内生涌现；末点经收盘集合竞价收敛到当日收盘）。 */
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

  /** 轻量集口径（≤50 只）：只算净流 + Kyle 出清，不做撮合。 */
  function light(code, i) {
    var d = dayData(code, i);
    var net = 0, amt = 0;
    for (var k = 0; k < d.agents.length; k++) { net += d.agents[k].net; amt += d.agents[k].amount; }
    return { code: code, i: i, net: net, amount: amt, adv: advNotional(code, i),
      imp: kyleImp(code, i, state.pending[code] || 0) };
  }

  /**
   * 可拉抬弹性（CP3-5）：0~100 分。由 ADV（流通盘代理）决定 —— 小盘易拉、大盘难拉。
   * 同一 X 元，得分越高偏离越大。
   */
  function elasticity(code, i) {
    var adv = advNotional(code, i);
    if (!(adv > 0)) return 0;
    // ADV 从 1e10 元（极难拉）到 1e8 元（极易拉）对数映射到 0~100
    var s = clamp((Math.log10(1e10) - Math.log10(adv)) / (Math.log10(1e10) - Math.log10(1e8)), 0, 1);
    return Math.round(s * 100);
  }

  /** 最近一次跟风放大倍数（供 UI 展示「散户正在跟进来」）。 */
  function herdOf(code) {
    var h = state.herd[code];
    return (h === undefined) ? 1 : h;
  }

  /* ------------------------------------------------------------ 反噬链（CP3-4） */

  /**
   * 反噬链判定：把玩家净流折算为参与率并登记，超限则触发监管事件。
   * @param {string} code
   * @param {number} idx  交易日下标
   * @param {number} flow 当日玩家净流（元）
   */
  function backlash(code, idx, flow) {
    var adv = advNotional(code, idx);
    if (!(adv > 0) || !flow) return;
    var part = Math.abs(flow) / adv;

    if (part > EVT_TIGER) {
      state.events.push({ i: idx, code: code, kind: 'tiger', part: +part.toFixed(4),
        text: '登上龙虎榜：单日净' + (flow > 0 ? '买入' : '卖出') +
          '占成交额 ' + (part * 100).toFixed(1) + '%，市场开始盯着你' });
    }
    var eff = Math.abs(impWith(code, idx, flow));
    if (eff > EVT_ABNORMAL) {
      state.events.push({ i: idx, code: code, kind: 'abnormal', part: +part.toFixed(4),
        text: '交易所下发异常波动问询：当日价格偏离基准 ' + (eff * 100).toFixed(2) + '%' });
    }
    if (part > RESTRICT_FLOW) {
      var log = state.restrictLog[code] || (state.restrictLog[code] = []);
      log.push([idx, part]);
      var recent = 0;
      for (var k = 0; k < log.length; k++) if (idx - log[k][0] < RESTRICT_SPAN) recent++;
      if (recent >= RESTRICT_N && !(state.restrict[code] > idx)) {
        state.restrict[code] = idx + RESTRICT_DAYS;
        state.events.push({ i: idx, code: code, kind: 'restrict', part: +part.toFixed(4),
          text: '被限制交易 ' + RESTRICT_DAYS + ' 个交易日：短期内多次大额申报，账户已被重点监控' });
      }
    }
  }

  /** 该标的当前是否处于限制交易期。 */
  function restricted(code, i) {
    var until = state.restrict[code];
    if (!until) return false;
    var ii = (i === undefined) ? currentIdx() : i;
    return ii < until;
  }

  /** 取走并清空待播报的反噬链事件（game.js 在 stepDay 后调用并写日志）。 */
  function takeEvents() {
    var e = state.events;
    state.events = [];
    return e;
  }

  /** 只读：待播报事件（不消费）。 */
  function events(code) {
    return state.events.filter(function (e) { return !code || e.code === code; });
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
    /* 玩家流改变了散户跟风信号 ⇒ 当日分时缓存失效，重算后玩家可在分时图上看到跟风 */
    delete cache[code + '@' + currentIdx()];
    return state.pending[code];
  }

  /**
   * 逐日推进（game.js 在 stepDay 里于 Market.next(1) 之后调用）：
   * ① 每个有 carry / 当日有玩家流的标的做一次 OU 递推并落盘 G.microCarry
   * ② 获利盘涌出（偏离过大且当日无新玩家流时的反向了结压力）
   * ③ 反噬链判定（龙虎榜 / 异常波动问询 / 限制交易）
   * ④ 热集（≤8）完整订单簿预计算，把 UI 冷启动摊到日推进里
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

      /* ① 玩家自有冲击 + 跟风放大 */
      var imp = impWith(code, idx, flow);
      if (imp !== 0) state.herd[code] = herdAmp(code, idx, flow);

      /* ② 获利盘涌出：偏离过大且当日无新玩家流时，获利/解套盘反向了结 */
      if (flow === 0 && Math.abs(prev) > PROFIT_TAKE) {
        imp -= sign(prev) * PROFIT_TAKE_K * (Math.abs(prev) - PROFIT_TAKE);
      }

      var th = thetaEff(code, idx, sigma, prev);
      var next = clamp(prev * Math.exp(-th) + imp, -CAP, CAP);
      if (!isFinite(next)) next = prev;
      var h = m[code] || (m[code] = []);
      h.push([idx, next]);
      if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);

      /* ③ 反噬链 */
      backlash(code, idx, flow);
    }
    state.pending = {};

    /* ④ 热集：完整订单簿预计算（≤8 只） */
    for (var hi = 0; hi < state.hot.length; hi++) minute(state.hot[hi], idx);
  }

  /* ------------------------------------------------------------ 生命周期 */

  function reset(seed) {
    state.seed = (seed === undefined) ? null : seed;
    state.hot = [];
    state.watch = [];
    state.pending = {};
    state.events = [];
    state.restrict = {};
    state.restrictLog = {};
    state.herd = {};
    cache = {};
    return true;
  }
  function getState() {
    var m = carryMap();
    var n = 0;
    for (var k in (m || {})) n++;
    return {
      stage: STAGE, enabled: enabled(), level: level(), seed: state.seed,
      hot: state.hot.slice(), watch: state.watch.slice(),
      cacheSize: Object.keys(cache).length,
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
  /** 轻量集（≤50 只）：只算净流 + Kyle 出清，不做撮合。 */
  function setWatch(codes) {
    state.watch = (codes || []).slice(0, 50);
    return state.watch.length;
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
    HERD_GAIN: HERD_GAIN,
    IGNITE_REF: IGNITE_REF,
    G_LIQ_MIN: G_LIQ_MIN,
    G_LIQ_MAX: G_LIQ_MAX,
    CLOSE_WIN: CLOSE_WIN,
    /* 配置 */
    enabled: enabled, level: level,
    /* 定价 */
    factor: factor, carry: carry, carryAt: carryAt,
    /* 玩家流 */
    applyPlayerFlow: applyPlayerFlow,
    /* 生命周期 */
    reset: reset, getState: getState, setOpt: setOpt, setHot: setHot, setWatch: setWatch,
    init: init, step: step,
    /* 微观读取 */
    minute: minute, ticks: ticks, book: book, agents: agents, anchor: anchor, light: light,
    /* CP3：跟风 / 反噬链 / 弹性 */
    herdOf: herdOf, herdAmp: herdAmp, events: events, takeEvents: takeEvents,
    restricted: restricted, elasticity: elasticity,
    /* 派生量（供测试/UI 复用同一口径） */
    advNotional: advNotional, kyleImp: kyleImp, thetaEff: thetaEff, impWith: impWith,
    playerSignal: playerSignal
  };
})();
