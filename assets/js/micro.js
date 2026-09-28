/* ============================================================================
 * micro.js —— 市场微观结构引擎（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * window.Micro · IIFE 单例 · 零依赖 · 零构建
 *
 * 【T02a 阶段 = 骨架】本阶段只把微观层「接进」定价链，**保证零影响**：
 *   - Micro.factor(code, i) 无条件返回字面量 1 ⇒ kAt 与接入前逐位相同
 *   - 不持有任何影响价格的可变状态；所有 T02b 预留接口均为空实现、调用无副作用
 * 【T02b 阶段】才真正实现订单簿 / 5 类代理 / 撮合 / Kyle λ / 引力锚 / 反噬链，
 *   届时 factor() 返回 exp(carry)（无玩家净流时恰为 1.0）。
 *
 * 契约（对齐架构设计 §决策2）：以宿主 Game.G 为唯一状态源，不私有缓存价格。
 * ========================================================================== */
window.Micro = (function () {
  'use strict';

  var STAGE = 'skeleton';            // 'skeleton'(T02a) → 'flow'(T02b+)
  var LEVELS = ['lite', 'std', 'hard'];

  // 仅用于 T02b 的占位状态（T02a 不参与任何价格计算）
  var state = { seed: null, carry: {}, hot: [] };

  /* ------------------------------------------------------------ 配置读取 */

  /** 读取宿主 Game.G.opt[key]，缺失时回落 dflt（宿主未就绪亦安全）。 */
  function optGet(key, dflt) {
    try {
      if (window.Game && Game.G && Game.G.opt && Game.G.opt[key] !== undefined) {
        return Game.G.opt[key];
      }
    } catch (e) { /* ignore */ }
    return dflt;
  }

  /** 微观结构总开关（默认开启）。 */
  function enabled() { return optGet('micro', true) !== false; }

  /** 微观结构档位：'lite' | 'std'(默认) | 'hard'（非法值收敛到 'std'）。 */
  function level() {
    var lv = optGet('microLevel', 'std');
    return LEVELS.indexOf(lv) !== -1 ? lv : 'std';
  }

  /* ------------------------------------------------------------ 定价接口 */

  /**
   * 订单流乘子（kAt 的第三因子）。
   * T02a：**无条件返回字面量 1** —— 保证 kAt 逐位等于 bfactorAt × swanFactor。
   * T02b：返回 exp(carry)；无玩家净流时 carry≡0 ⇒ 精确 1.0。
   * @param {string} code
   * @param {number} [i]
   * @returns {number}
   */
  function factor(code, i) {
    return 1;
  }

  /** 当前引力锚累积偏离（对数域）。T02a：恒为 0。 */
  function carry(code) { return 0; }

  /* ------------------------------------------------------------ 生命周期 */

  /** 重开一局：重置种子与派生状态。 */
  function reset(seed) {
    state.seed = (seed === undefined) ? null : seed;
    state.carry = {};
    state.hot = [];
    return true;
  }

  /** 状态快照（只读副本，便于验证与调试）。 */
  function getState() {
    return {
      stage: STAGE,
      enabled: enabled(),
      level: level(),
      seed: state.seed,
      hot: state.hot.slice(),
      carry: Object.assign({}, state.carry)
    };
  }

  /** 玩法开关变更钩子（T02a 占位；T02b 在 micro/microLevel 变化时清理状态）。 */
  function setOpt(key, val) { return true; }

  /** 设置热集（完整订单簿标的，≤8）。T02a 仅记录，不产生副作用。 */
  function setHot(codes) {
    state.hot = (codes || []).slice(0, 8);
    return state.hot.length;
  }

  /* ------------------------------------------------ T02b 预留接口（空实现） */

  function init(G, deps) { return true; }
  function step(G, i) { /* T02b: 逐日推进订单流 */ }
  function minute(code, i) { return []; }                 // 逐笔 → 分钟聚合
  function book(code) { return { bids: [], asks: [] }; }  // 盘口五档
  function agents(code) { return []; }                    // 5 类代理净流入
  function applyPlayerFlow(G, code, X) { return 0; }      // 玩家冲击
  function anchor(code, i) { return 0; }                  // 引力锚

  return {
    STAGE: STAGE,
    LEVELS: LEVELS,
    /* 配置 */
    enabled: enabled, level: level,
    /* 定价 */
    factor: factor, carry: carry,
    /* 生命周期 */
    reset: reset, getState: getState, setOpt: setOpt, setHot: setHot,
    /* T02b 预留 */
    init: init, step: step, minute: minute, book: book,
    agents: agents, applyPlayerFlow: applyPlayerFlow, anchor: anchor
  };
})();
