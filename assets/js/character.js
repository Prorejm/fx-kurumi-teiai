/* ============================================================
 * character.js — 帝爱「风控顾问」徽记系统
 *
 * 对外契约与原版保持一致（ui.js / main.js 无需改动）：
 *   Char.face(state, opts) -> SVG 字符串
 *   Char.FACES / Char.line(key) / Char.lineForState(state)
 *   Char.mood(summary) / Char.star(cx,cy,r,fill) / Char.starRaw(...)
 *
 * 造型语言：帝爱集团六边徽记 + 四角星 + 波浪
 * 状态不再靠夸张颜艺，而是靠「徽记配色 + 环形进度」表达
 * ========================================================== */
window.Char = (function () {
  'use strict';

  /* ---------- 帝爱配色 ---------- */
  const NAVY = '#17385f';
  const NAVY_D = '#0f2740';
  const NAVY_SOFT = '#ecf1f8';
  const GOLD = '#c9a227';
  const GOLD_D = '#a87e26';
  const GOLD_SOFT = '#f8f3e2';
  const GREEN = '#158a5b';
  const GREEN_SOFT = '#eaf6f0';
  const RED = '#c8382c';
  const RED_SOFT = '#fceeec';
  const WARN = '#b8860b';
  const WARN_SOFT = '#fdf6e3';
  const GREY = '#6d7787';
  const GREY_SOFT = '#eceae4';

  /* ---------- 状态表：配色 + 环形进度 + 裂纹 ---------- */
  const MOODS = {
    greeting: { ring: NAVY, fill: NAVY, star: GOLD, pct: .34, tag: '开户顾问' },
    idle: { ring: NAVY, fill: NAVY, star: GOLD, pct: .26, tag: '盯盘中' },
    think: { ring: NAVY, fill: NAVY, star: GOLD, pct: .30, tag: '研判中' },
    smug: { ring: NAVY, fill: NAVY, star: GOLD, pct: .40, tag: '稳' },
    happy: { ring: GREEN, fill: NAVY, star: GOLD, pct: .56, tag: '浮盈' },
    zen: { ring: GOLD_D, fill: NAVY, star: GOLD, pct: .50, tag: '静观', zen: true },
    wide: { ring: NAVY, fill: NAVY, star: GOLD, pct: .48, tag: '注视' },
    eager: { ring: GOLD, fill: GOLD_D, star: GOLD, pct: .92, tag: '加仓倾向' },
    greedy: { ring: GOLD, fill: GOLD_D, star: GOLD, pct: .97, tag: '重仓' },
    worry: { ring: WARN, fill: NAVY, star: WARN, pct: .60, tag: '留意回撤' },
    angry: { ring: RED, fill: '#7d2a22', star: RED, pct: .86, tag: '情绪化' },
    panic: { ring: RED, fill: RED, star: '#ffffff', pct: .93, tag: '追保' },
    blowup: { ring: RED, fill: '#7d2a22', star: RED, pct: .96, tag: '强制平仓', crack: true },
    sad: { ring: GREY, fill: '#3f4a5b', star: GREY, pct: .44, tag: '回撤' },
    broken: { ring: GREY, fill: '#3f4a5b', star: GREY, pct: .28, tag: '重创', crack: true },
    dead: { ring: '#2b3340', fill: '#2b3340', star: GREY, pct: .10, tag: '已清算', crack: true },
    restart: { ring: NAVY, fill: NAVY, star: GOLD, pct: .30, tag: '重新开户' }
  };
  const FACES = MOODS;   // 兼容旧键名

  /* ---------- 图形基元 ---------- */

  /* 平顶正六边形 */
  function hex(cx, cy, r) {
    const p = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i;
      p.push((cx + Math.cos(a) * r).toFixed(2) + ',' + (cy + Math.sin(a) * r).toFixed(2));
    }
    return 'M' + p.join('L') + 'Z';
  }

  /* 四角星（温和的「闪光」形，比五角星柔和） */
  function fourStar(cx, cy, r, fill, op) {
    const w = r * 0.20;
    const d = 'M' + cx + ',' + (cy - r) +
      'Q' + (cx + w) + ',' + (cy - w) + ',' + (cx + r) + ',' + cy +
      'Q' + (cx + w) + ',' + (cy + w) + ',' + cx + ',' + (cy + r) +
      'Q' + (cx - w) + ',' + (cy + w) + ',' + (cx - r) + ',' + cy +
      'Q' + (cx - w) + ',' + (cy - w) + ',' + cx + ',' + (cy - r) + 'Z';
    return '<path d="' + d + '" fill="' + fill + '"' +
      (op === undefined || op === 1 ? '' : ' opacity="' + op + '"') + '/>';
  }

  /* 五角星（保留旧接口，供评级等使用） */
  function star(cx, cy, r, fill) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push((cx + Math.cos(a) * rr).toFixed(1) + ',' + (cy + Math.sin(a) * rr).toFixed(1));
    }
    return '<polygon points="' + pts.join(' ') + '" fill="' + fill + '" stroke="' + NAVY_D + '" stroke-width="1.4"/>';
  }

  /* 裂纹 */
  function crack() {
    return '<g opacity=".5" stroke="#ffffff" stroke-width="1.3" fill="none" stroke-linecap="round">' +
      '<path d="M46,30 L57,50 L48,62"/>' +
      '<path d="M76,44 L66,60 L78,74"/>' +
      '</g>';
  }

  /* 内外双波（帝爱资金流） */
  function waves(top) {
    return '<g fill="none" stroke-linecap="round">' +
      '<path d="M28,' + top + 'Q44,' + (top - 10) + ',60,' + top + 'T92,' + top + '" stroke="' + GOLD + '" stroke-width="2" opacity=".92"/>' +
      '<path d="M34,' + (top + 9) + 'Q46,' + (top + 2) + ',58,' + (top + 9) + 'T82,' + (top + 9) + '" stroke="' + GOLD + '" stroke-width="1.2" opacity=".5"/>' +
      '</g>';
  }

  /* ---------- 主渲染 ---------- */
  const CIRC = 2 * Math.PI * 56;   // 环形周长

  function face(name, opt) {
    const m = MOODS[name] || MOODS.idle;
    opt = opt || {};
    const arc = (CIRC * m.pct).toFixed(1);
    return '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" ' +
      'class="av-svg ' + (opt.anim || '') + '" role="img" aria-label="帝爱风控徽记 · ' + m.tag + '">' +
      /* 状态环 */
      '<circle cx="60" cy="60" r="56" fill="none" stroke="' + m.ring + '" stroke-width="2.6" ' +
      'stroke-dasharray="' + arc + ' ' + CIRC.toFixed(1) + '" stroke-linecap="round" ' +
      'transform="rotate(-90 60 60)" opacity=".45"/>' +
      /* 徽记主体 */
      '<path d="' + hex(60, 60, 52) + '" fill="' + m.fill + '" stroke="' + m.ring + '" ' +
      'stroke-width="3" stroke-linejoin="round"/>' +
      '<path d="' + hex(60, 60, 44) + '" fill="none" stroke="' + GOLD + '" stroke-width="1.1" ' +
      'stroke-linejoin="round" opacity=".55"/>' +
      /* 星与波 */
      fourStar(60, 46, 21, m.star) +
      fourStar(37, 68, 5.4, m.star, .78) +
      fourStar(83, 68, 5.4, m.star, .78) +
      waves(88) +
      (m.zen ? '<circle cx="60" cy="60" r="35" fill="none" stroke="' + GOLD + '" stroke-width=".8" opacity=".38"/>' : '') +
      (m.crack ? crack() : '') +
      '</svg>';
  }

  /* ---------- 台词库：帝爱风控顾问口吻 ---------- */
  const LINES = {
    greeting: [
      '钱不够？那不是问题——是<b>机会</b>。',
      '帝爱证券，随时为您<b>提供资金</b>。',
      '本金越少，翻身的欲望越强。我们喜欢这种客户。',
      '先看看额度吧。利息的事，<b>以后</b>再说。'
    ],
    idle: [
      '行情平稳。要不要趁现在建一点仓？',
      '盘面没什么波动——正好适合下单。',
      '看中了就直接买。等回调的人，通常等不到。',
      '账户还有额度没用上。闲置资金是浪费。'
    ],
    think: [
      '我在算你这笔的维持担保比例。',
      '再跌 8%，您就需要追加保证金了。',
      '建议先看一下近 20 日均线。'
    ],
    happy: [
      '浮盈不错。要不要把利润再<b>押上</b>？',
      '赚了钱还留着现金？这不合理。',
      '这种时候加仓，收益才配得上您的胆量。'
    ],
    smug: ['稳。但稳只能保住本金。', '小赚。不过离目标还很远。'],
    eager: [
      '额度还有，仓位太轻了。',
      '再买一点，摊薄成本——或者干脆重仓。',
      '机会不会等您准备好。'
    ],
    greedy: [
      '<b>再加一点。</b>就一点。',
      '杠杆只用了一半，太保守了。',
      '现在收手，前面的风险就白担了。'
    ],
    wide: ['盯住盘口。大单在动了。', '成交在放大，注意方向。'],
    worry: [
      '只是技术性回调。基本面没变。',
      '跌一点就慌，做不了大事。',
      '维持率还有余量，扛得住。'
    ],
    angry: ['市场不理性，不是你的判断错了。', '这种下跌没有道理，扛过去。'],
    panic: [
      '<b>维持担保比例告急。</b>请立即追加保证金。',
      '请在收盘前补足担保物，否则将进入平仓程序。',
      '追保通知已发出。这不是建议。'
    ],
    sad: ['回撤在正常范围内……大概。', '本金还在，只是少了一点。', '下一把能赢回来。'],
    broken: [
      '账户已严重受损，请勿继续加仓。',
      '留在牌桌上的人，才有翻本的机会。',
      '还差一点就翻回来了——再借一笔？'
    ],
    dead: [
      '<b>已通知清算。</b>',
      '资金归零。帝爱已为您安排后续去处。',
      '欢迎前往地下劳动施设，<b>债务可以慢慢还</b>。'
    ],
    zen: ['不操作，也是一种操作。', '空仓等待，是极少数人的能力。', '耐心是唯一免费的 alpha。'],
    blowup: [
      '维持担保比例已跌破 100%。',
      '<b>强制平仓</b>已执行完毕。',
      '账户已被清算，剩余债务仍需承担。'
    ],
    restart: ['重新开户吧。这次额度会更高。', '我们会记住您上一次的表现。'],
    leverUp: ['杠杆已上调。恭喜，您离暴富更近了。', '更高杠杆意味着更低的保证金——也更快出局。'],
    leverDown: ['杠杆下调。稳健是一种选择。', '仓位变轻了，收益也会变轻。'],
    t1: ['T+1 是规则。今天买入的，明天才能卖。', '想做 T+0？换个品种吧，可转债可以。'],
    limitUp: ['涨停。封单很大，追不进去了。', '这种票，早买一天就不一样了。'],
    limitDown: ['跌停。卖不出去，只能拿着。', '一字板。这才是真正的流动性风险。']
  };

  function line(key) {
    const arr = LINES[key] || LINES.idle;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ---------- 账户表现 → 状态 ---------- */
  function mood(acc) {
    if (!acc) return 'idle';
    if (acc.ruin) return 'dead';
    if (acc.leverage > 1) {
      if (acc.marginRatio !== null && acc.marginRatio !== undefined && acc.marginRatio <= 130) return 'panic';
      if (acc.marginRatio !== null && acc.marginRatio !== undefined && acc.marginRatio <= 200) return 'worry';
    }
    const r = acc.returnPct;
    if (acc.realizedToday > 0 || (acc.unrealizedPct > 8)) return 'greedy';
    if (r >= 20) return 'greedy';
    if (r >= 8) return 'happy';
    if (r >= 2) return 'smug';
    if (r <= -25) return 'broken';
    if (r <= -12) return 'sad';
    if (r <= -5) return 'worry';
    return 'idle';
  }

  function lineForState(state) {
    if (LINES[state]) return line(state);
    if (state === 'smug') return line('smug');
    return line('idle');
  }

  return {
    face: face,
    FACES: FACES,
    MOODS: MOODS,
    line: line,
    lineForState: lineForState,
    mood: mood,
    star: star,
    starRaw: star
  };
})();
