/* ============================================================
   ui.js — 视图渲染 / 交互
   ========================================================== */
window.UI = (function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const el = {};
  const S = {
    code: '', view: 'kline', bars: 90, offset: 0,
    sort: 'chg', filter: '', rows: {}, posRows: {},
    tempFace: null, faceTimer: 0, lastFace: '', layout: null,
    auto: null, curBarsCache: null, zone: 'A', direction: 'long'
  };

  function num(v, d) { return (+v || 0).toFixed(d === undefined ? 2 : d); }
  function money(n, long) {
    if (!isFinite(n)) return '--';
    const a = Math.abs(n);
    if (long || a < 10000) return (n < 0 ? '-' : '') + '¥' + Math.round(a).toLocaleString('en-US');
    return (n < 0 ? '-' : '') + '¥' + (a / 10000).toFixed(2) + '万';
  }
  function cls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
  function pct(v) { return (v >= 0 ? '+' : '') + num(v, 2) + '%'; }

  function cache() {
    ['app', 'intro', 'boot', 'bootBar', 'sEquity', 'sReturn', 'sAvail', 'sMktVal', 'sPnl',
      'charAvatar', 'charBubble', 'introAvatar', 'introLine', 'modeBadge', 'dateBadge', 'liveDot',
      'mbVal', 'mbFill', 'levChip', 'marginBar', 'debtChip', 'cashChip', 'stockList', 'posList', 'logList', 'badges',
      'curName', 'curCode', 'curPrice', 'curChg', 'curOpen', 'curHigh', 'curLow', 'curPrev', 'curTurn',
      'indexStrip', 'kchart', 'equityChart', 'crosshair', 'priceInput', 'qtyInput', 'qtyUnit',
      'calcAmt', 'calcFee', 'calcMargin', 'calcSlip', 'buyBtn', 'sellBtn', 'buySub', 'sellSub',
      'searchInput', 'sortBtn', 'nextDayBtn', 'next5Btn', 'autoBtn', 'leverBtn', 'restartBtn',
      'closeAllBtn', 'clearLog', 'posCount', 'addFill', 'addTxt', 'statsMini', 'toast',
      'fx', 'fxAvatar', 'fxWord', 'fxSub', 'fxBtn', 'startBtn', 'continueBtn',
      'introLev', 'introLevVal', 'levModal', 'levSlider', 'levVal', 'levOk',
      'loanBtn', 'loanModal', 'loanTabs', 'loanBody',
      'wealthBtn', 'wealthModal', 'wealthTabs', 'wealthBody',
      'newsBar', 'newsTag', 'newsView', 'newsTrack', 'swanLive',
      'lbBtn', 'lbModal', 'lbBody', 'lbRecord', 'lbClear',
      'setBtn', 'setModal', 'setBody',
      'lawBtn', 'lawModal', 'lawBody'
    ].forEach(id => { el[id] = document.getElementById(id); });
    el.chartWrap = $('.chart-wrap');
    el.crosshair = document.getElementById('crosshair');
  }

  /* ---------------- Toast ---------------- */
  let toastT = 0;
  function toast(msg, kind) {
    const t = el.toast; if (!t) return;
    t.innerHTML = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = 'toast ' + (kind || ''); }, 2400);
  }

  /* ---------------- 表情 ---------------- */
  function setFace(state, lineHtml, anim) {
    if (!el.charAvatar) return;
    el.charAvatar.innerHTML = Char.face(state, { anim: anim || '' });
    if (lineHtml) el.charBubble.innerHTML = '<div class="bubble"><p>' + lineHtml + '</p></div>';
    S.lastFace = state;
  }
  function tempFace(state, lineHtml, ms, anim) {
    S.tempFace = { state, line: lineHtml, anim };
    clearTimeout(S.faceTimer);
    S.faceTimer = setTimeout(() => { S.tempFace = null; refreshFace(); }, ms || 2600);
    refreshFace();
  }
  function refreshFace(force) {
    const s = Game.summary();
    if (S.tempFace) { setFace(S.tempFace.state, S.tempFace.line, S.tempFace.anim); return; }
    if (s.ruin) { setFace('dead', Game.G._lastWords || Char.lineForState('dead'), 'av-shake'); return; }
    const st = Char.mood(s);
    setFace(st, Char.lineForState(st),
      st === 'panic' ? 'av-shake'
        : (st === 'broken' || st === 'dead') ? 'av-shake'
          : st === 'greedy' ? 'av-bounce' : '');
  }

  /* ---------------- 股票池 ---------------- */
  function buildWatch() {
    S.rows = {};
    el.stockList.innerHTML = '';
    const q = S.filter.trim().toLowerCase();
    let list = Market.tradable;
    if (S.zone && S.zone !== 'ALL') list = list.filter(m => m.zone === S.zone);
    if (q) list = list.filter(m =>
      m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) ||
      (m.ind || '').toLowerCase().includes(q));
    const arr = list.map(m => {
      const b = Market.bar(m.code);
      const c = Game.pxChg(m.code);
      return { m, b, c };
    });
    arr.sort((a, b) => {
      if (S.sort === 'chg') return b.c.pct - a.c.pct;
      if (S.sort === 'price') return (b.c.now || 0) - (a.c.now || 0);
      if (S.sort === 'name') return a.m.name.localeCompare(b.m.name, 'zh');
      return a.m.code.localeCompare(b.m.code);
    });
    if (!arr.length) {
      el.stockList.innerHTML = '<div class="empty">没有匹配的股票<br>试试搜「茅台」「银行」</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    arr.forEach(x => {
      const d = document.createElement('div');
      d.className = 'srow' + (x.m.code === S.code ? ' on' : '');
      d.dataset.code = x.m.code;
      d.innerHTML = `<div class="nm"><b>${x.m.name}</b><i>${x.m.code.slice(2)} · ${x.m.ind}</i></div>
        <div class="pv"><b data-p>—</b><span data-c>—</span></div>`;
      S.rows[x.m.code] = { node: d, p: d.querySelector('[data-p]'), c: d.querySelector('[data-c]') };
      frag.appendChild(d);
    });
    el.stockList.appendChild(frag);
    updateWatch();
  }

  function updateWatch() {
    for (const code in S.rows) {
      const r = S.rows[code];
      const c = Game.pxChg(code);
      if (!c.now) continue;
      const k = cls(c.pct);
      r.p.textContent = num(c.now);
      r.p.className = k;
      r.c.textContent = (c.abs >= 0 ? '+' : '') + num(c.abs) + ' ' + pct(c.pct);
      r.c.className = k;
    }
    renderIndexStrip();
  }

  function renderIndexStrip() {
    if (!el.indexStrip) return;
    /* 只取大盘指数 (rp/wm 已从 tradable 剔除, 但这里需显式按 market 过滤) */
    const idxs = Market.meta.filter(m => m.market === 'index');
    el.indexStrip.innerHTML = idxs.slice(0, 4).map(m => {
      const c = Game.pxChg(m.code);
      if (!c.now) return '';
      return `<div class="idx">${m.name}<b class="${cls(c.pct)}">${num(c.now, 1)}</b>
        <span class="${cls(c.pct)}">${pct(c.pct)}</span></div>`;
    }).join('');
  }

  /* 最小交易单位: 可转债 10 张, 其余 100 股 */
  function lotOf(code) { return Game.lot(code || S.code); }
  function unitOf(code) { return Market.isCB(code || S.code) ? '张' : '股'; }

  /* ---------------- 滚动快讯 (RSS + 盘面实时播报) ---------------- */
  const NEWS_CACHE = { idx: -1, day: '', list: null };

  /* 由当日真实盘面生成快讯 —— 保证「游戏内日期」与新闻一致 (历史回放模式下尤其重要) */
  function genHeadlines() {
    const out = [];
    const big = [
      ['sh000001', '沪指'], ['sz399001', '深成指'],
      ['sz399006', '创业板指'], ['sh000300', '沪深300']
    ];
    big.forEach(([c, n]) => {
      const cg = Game.pxChg(c);
      if (!cg || !isFinite(cg.pct) || cg.pct === 0) return;
      const k = cg.pct >= 0;
      let tail = '';
      if (Math.abs(cg.pct) >= 2) tail = '，市场情绪' + (k ? '明显回暖' : '显著承压');
      else if (Math.abs(cg.pct) >= 1) tail = '，' + (k ? '多头占据主动' : '抛压有所释放');
      else tail = '，' + (k ? '小幅收红' : '震荡收绿');
      out.push({ t: `${n}${k ? '涨' : '跌'} ${Math.abs(cg.pct).toFixed(2)}%${tail}`,
        src: '盘面', kind: k ? 'hot' : 'cool' });
    });

    /* 行业板块涨跌 (按 meta.ind 分组聚合) */
    const grp = {};
    Market.tradable.forEach(m => {
      if (m.market !== 'main' && m.market !== 'gem' && m.market !== 'star') return;
      const c = Game.pxChg(m.code);
      if (!c || !isFinite(c.pct)) return;
      const k = m.ind || '其他';
      if (!grp[k]) grp[k] = { s: 0, n: 0 };
      grp[k].s += c.pct; grp[k].n++;
    });
    const sectors = Object.keys(grp).map(k => ({ k, v: grp[k].s / grp[k].n }))
      .sort((a, b) => b.v - a.v);
    if (sectors.length) {
      const t = sectors[0], b = sectors[sectors.length - 1];
      if (t && t.v > 0.8) out.push({ t: `${t.k}板块领涨两市，板块均涨幅 ${t.v.toFixed(2)}%，资金关注度居前`, src: '板块', kind: 'hot' });
      if (b && b.v < -0.8) out.push({ t: `${b.k}板块走弱，板块均跌幅 ${Math.abs(b.v).toFixed(2)}%，短期承压`, src: '板块', kind: 'cool' });
      /* 分化描述 */
      if (t && b && t.v - b.v > 4) out.push({ t: `盘面分化明显：${t.k}与${b.k}板块首尾相差 ${(t.v - b.v).toFixed(1)} 个百分点`, src: '板块' });
    }

    /* 个股异动 (全市场市值大/成交活跃者优先) */
    const moves = [];
    Market.tradable.forEach(m => {
      if (m.market === 'fx' || m.market === 'fd') return;
      const c = Game.pxChg(m.code);
      if (!c || !isFinite(c.pct)) return;
      moves.push({ code: m.code, name: m.name, pct: c.pct, mv: Game.px(m.code) * Market.avgVol(m.code, 20) });
    });
    moves.sort((a, b) => b.mv - a.mv);
    const liquid = moves.slice(0, 90);
    const up = liquid.slice().sort((a, b) => b.pct - a.pct).slice(0, 3);
    const dn = liquid.slice().sort((a, b) => a.pct - b.pct).slice(0, 3);
    up.forEach(x => {
      if (x.pct < 3) return;
      const lu = x.pct >= 9.5 ? '涨停' : ('涨 ' + x.pct.toFixed(2) + '%');
      out.push({ t: `${x.name} ${lu}，居两市涨幅榜前列`, src: '个股', kind: 'hot' });
    });
    dn.forEach(x => {
      if (x.pct > -3) return;
      const ld = x.pct <= -9.5 ? '跌停' : ('跌 ' + Math.abs(x.pct).toFixed(2) + '%');
      out.push({ t: `${x.name} ${ld}，资金出逃迹象明显`, src: '个股', kind: 'cool' });
    });

    /* 可转债异动 */
    Market.meta.filter(m => m.market === 'cb').forEach(m => {
      const c = Game.pxChg(m.code);
      if (c && Math.abs(c.pct) >= 5)
        out.push({ t: `${m.name} 波动放大 ${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%，转债 T+0 交易活跃`,
          src: '转债', kind: c.pct >= 0 ? 'hot' : 'cool' });
    });

    /* 我的持仓相关 */
    Game.G.positions.forEach(p => {
      const c = Game.pxChg(p.code);
      if (!c) return;
      const m = Market.metaOf(p.code) || { name: p.code };
      if (c.pct >= 9.5) out.push({ t: `持仓提醒：${m.name} 涨停，你的浮盈正在扩大`, src: '持仓', kind: 'hot' });
      else if (c.pct <= -9.5) out.push({ t: `持仓提醒：${m.name} 跌停，注意维持担保比例`, src: '持仓', kind: 'cool' });
    });

    /* 分红到账 */
    const dl = Game.G.divLog && Game.G.divLog[0];
    if (dl && dl.day === Market.date()) {
      out.push({ t: `${dl.name} 今日除权除息，每股派现 ${dl.perShare.toFixed(4)} 元，持股满 1 年免征红利税`, src: '分红', kind: 'hot' });
    }

    /* 黑天鹅事件播报 —— 让玩家知道「历史被改写了」 */
    Game.activeSwans().slice(0, 4).forEach(sv => {
      const left = Math.max(0, sv.endIdx - Market.idx);
      out.push({
        t: `【${sv.kind === 'bear' ? '利空' : '利好'}冲击 · ${sv.name}】${sv.t}` +
          (left > 0 ? `（预计还将持续 ${left} 个交易日）` : '（冲击窗口已结束，价格水平已永久重估）'),
        src: '黑天鹅', kind: sv.kind === 'bear' ? 'cool' : 'hot'
      });
    });

    /* 操作的反作用力提示 —— 让玩家理解「蝴蝶效应」不是装饰 */
    if (Game.G.butterfly > 0.05) {
      out.push({ t: `风险提示：你的交易行为已对市场产生扰动（${Math.round(Game.G.butterfly * 100)}%），历史走势不再完全可信`,
        src: '系统', kind: 'cool' });
    }
    const shortPos = Game.G.positions.filter(p => p.side === 'short');
    if (shortPos.length) {
      out.push({ t: `融券负债提醒：当前 ${shortPos.length} 笔空头持仓，融券费率年化 ${(Game.SHORT_FEE_RATE * 100).toFixed(0)}%，按日计提`,
        src: '系统' });
    }
    if (Market.isCB(S.code) || Game.G.cbApplies.length) {
      if (Game.G.cbApplies.length) out.push({ t: `可转债申购进行中：${Game.G.cbApplies.length} 笔待公布中签结果，中签后请务必备足缴款资金`, src: '打新' });
    }
    return out;
  }

  function newsItems() {
    const day = Market.date();
    const sig = day + '|' + Game.G.swans.length + '|' + Game.G.positions.length;
    if (NEWS_CACHE.list && NEWS_CACHE.day === sig) return NEWS_CACHE.list;
    const list = genHeadlines();
    /* 真实 RSS 快讯 (构建期内置 / 运行期中继刷新) */
    const rss = (Market.news || []).slice(0, 26).map(n => ({
      t: n.t, src: n.src || 'RSS', url: n.u
    }));
    const merged = list.concat(rss);
    NEWS_CACHE.day = sig;
    NEWS_CACHE.list = merged;
    return merged;
  }

  function renderNews() {
    if (!el.newsTrack) return;
    const items = newsItems();
    if (!items.length) { el.newsTrack.innerHTML = '<span class="nb-item">暂无快讯</span>'; return; }
    const one = items.map(n =>
      `<span class="nb-item ${n.kind || ''}">` +
      (n.kind ? `<i class="tagp">${n.src}</i>` : `<i class="src">${n.src}</i>`) +
      (n.url ? `<a href="${n.url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${n.t}</a>` : n.t) +
      `</span><span class="nb-sep">◆</span>`
    ).join('');
    /* 双份内容 + translateX(-100%) 实现无缝滚动 */
    el.newsTrack.innerHTML = one + one;
    const chars = items.reduce((s, n) => s + n.t.length + 14, 0);
    const dur = Math.max(40, Math.min(240, chars / 6));
    el.newsTrack.style.animationDuration = dur + 's';
    if (el.newsTag) {
      el.newsTag.textContent = '快讯 ' + Market.date().slice(5);
      el.newsTag.title = (Market.newsFetchedAt
        ? 'RSS 实时中继刷新于 ' + new Date(Market.newsFetchedAt).toLocaleTimeString('zh-CN')
        : '使用构建期内置 RSS 快讯') + ' · 鼠标悬停可暂停滚动';
    }
  }

  function refreshNews() {
    NEWS_CACHE.list = null;
    renderNews();
  }

  /* 生效中的黑天鹅事件提示条 */
  function renderSwan() {
    if (!el.swanLive) return;
    const list = Game.activeSwans();
    if (!list.length || (Game.G.opt && Game.G.opt.blackswan === false)) {
      el.swanLive.classList.add('hidden');
      return;
    }
    const bear = list.filter(s => s.kind === 'bear').length >= list.length / 2;
    el.swanLive.classList.remove('hidden');
    el.swanLive.classList.toggle('bull', !bear);
    el.swanLive.innerHTML = `<span class="lbl">${bear ? '📉 黑天鹅生效中' : '📈 利好冲击生效中'}</span>` +
      list.slice(0, 3).map(s => {
        const done = Math.max(0, Math.min(s.days, Market.idx - s.startIdx));
        return `<span class="sw" title="${s.t}｜${s.tip}">${s.name}<i>${done}/${s.days} · 日均 ${(s.drift * 100).toFixed(2)}%</i></span>`;
      }).join('') +
      (list.length > 3 ? `<span class="sw">+${list.length - 3} 起</span>` : '');
  }

  function renderPos() {
    if (!Game.G.positions.length) {
      el.posList.innerHTML = '<div class="empty">空仓。<br>空仓也是一种操作。</div>';
      el.posCount.textContent = '0';
      return;
    }
    el.posCount.textContent = String(Game.G.positions.length);
    el.posList.innerHTML = Game.G.positions.map(p => {
      const meta = Market.metaOf(p.code) || { name: p.code, ind: '' };
      const pr = Game.px(p.code);
      const unit = unitOf(p.code);
      const mv = pr * p.shares, cost = p.cost * p.shares;
      const pnl = (p.side === 'short') ? (p.cost - pr) * p.shares : (pr - p.cost) * p.shares;
      const r = cost ? pnl / cost * 100 : 0;
      const can = Game.canSellShares(p.code);
      const frozen = can < p.shares ? (Market.isCB(p.code) ? '' : ' (T+1冻结)') : '';
      const sideTag = `<i class="side-tag ${p.side}">${p.side === 'short' ? '空' : '多'}</i>`;
      /* 融券负债 / 已到账分红 —— 帮助玩家理解「操作的反作用力」 */
      const divs = (p.divs || []).reduce((s, d) => s + d.perShare, 0) * p.shares;
      const slip = Game.G.impact[p.code] || 0;
      let extra = '';
      if (p.side === 'short') {
        extra = `<div class="p-extra">融券负债 ${p.shares}${unit} · 融券费 ${num(pr * p.shares * Game.SHORT_FEE_RATE / 252, 2)}/日</div>`;
      } else if (divs > 0 || slip > 0) {
        const bits = [];
        if (divs > 0) bits.push('已派现 ' + money(divs));
        if (slip > 0.01) bits.push('冲击成本 ' + money(slip));
        extra = `<div class="p-extra">${bits.join(' · ')}</div>`;
      }
      return `<div class="prow ${p.code === S.code ? 'on' : ''}" data-code="${p.code}">
        <div class="r1"><b>${meta.name}</b>${sideTag}<em>${p.shares}${unit}${frozen}</em>
          <span class="${cls(pnl)}">${pct(r)}</span></div>
        <div class="r2">
          <div><span>成本</span><b>${num(p.cost)}</b></div>
          <div><span>现价</span><b class="${cls(pr - p.cost)}">${num(pr)}</b></div>
          <div><span>市值</span><b>${money(mv)}</b></div>
          <div><span>盈亏</span><b class="${cls(pnl)}">${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}</b></div>
        </div>${extra}</div>`;
    }).join('');
  }

  function renderLog() {
    if (!Game.G.log.length) {
      el.logList.innerHTML = '<div class="empty">还没有任何操作记录</div>';
      return;
    }
    el.logList.innerHTML = Game.G.log.slice(0, 60).map(l => {
      const day = (l.day || '').slice(5);
      let c = '';
      if (l.kind === '买入') c = 'up';
      else if (l.kind === '卖出') c = l.cls === 'up' ? 'up' : 'down';
      else if (l.kind === '割肉' || l.kind === '强制平仓') c = 'down';
      else if (l.kind === '系统') c = 'up';
      else if (l.kind === '成就') c = 'up';
      return `<div class="lrow"><time>${day}</time><div><em class="${c}">${l.kind}</em>
        ${l.name ? l.name + ' ' : ''}${l.text}</div></div>`;
    }).join('');
  }

  /* ---------------- 顶栏报价 ---------------- */
  function renderTop() {
    if (!S.code) return;
    const meta = Market.metaOf(S.code) || {};
    const b = Market.bar(S.code);
    if (!b) return;
    const c = Game.pxChg(S.code);
    const lim = Game.limits(S.code);
    const k = Game.kAt(S.code, Market.idx);
    el.curName.textContent = meta.name || S.code;
    el.curCode.textContent = S.code + ' · ' + (meta.ind || '');
    el.curPrice.textContent = num(c.now || b.c);
    el.curPrice.className = cls(c.pct);
    el.curChg.innerHTML = `<span class="${cls(c.pct)}">${c.abs >= 0 ? '+' : ''}${num(c.abs)} ${pct(c.pct)}</span>` +
      (Game.shadowed(S.code) ? `<i class="shadow-tag" title="该标的已受蝴蝶效应 / 黑天鹅扰动，价格与原始历史不同">扰动 ${((k - 1) * 100).toFixed(1)}%</i>` : '');
    el.curOpen.textContent = num(b.o * k); el.curHigh.textContent = num(b.h * k);
    el.curLow.textContent = num(b.l * k); el.curPrev.textContent = num(lim.pc);
    const q = Market.S.quotes[S.code];
    el.curTurn.textContent = q && q.turn ? num(q.turn) + '%' : (Market.S.mode === 'live' ? '--' : '—');
    /* 交易单位: 可转债按「张」(1手=10张), 其余按「股」 */
    const unit = unitOf(S.code);
    if (el.qtyUnit) el.qtyUnit.textContent = unit + (Market.isCB(S.code) && lim.firstDay ? ' · 首日' : '');
    const posDiv = Game.pos(S.code);
    el.sellSub.textContent = '可卖 ' + (posDiv ? Game.canSellShares(S.code) : 0) + ' ' + unit;
  }

  /* ---------------- HUD ---------------- */
  function renderHud() {
    const s = Game.summary();
    el.sEquity.textContent = money(s.equity, true);
    el.sEquity.className = 'stat-v ' + cls(s.returnPct);
    el.sReturn.textContent = pct(s.returnPct);
    el.sReturn.className = 'stat-v ' + cls(s.returnPct);
    el.sAvail.textContent = money(s.avail);
    el.sMktVal.textContent = money(s.mv);
    el.sPnl.textContent = (s.unrealized >= 0 ? '+' : '-') + money(Math.abs(s.unrealized));
    el.sPnl.className = 'stat-v ' + cls(s.unrealized);
    el.dateBadge.textContent = Market.date() + ' · 第 ' + (Market.idx - Game.G.startIdx + 1) + ' 天';
    el.modeBadge.textContent = Game.G.mode === 'live' ? '实盘同步' : '历史回放';

    /* 维持率 */
    const L = Game.G.leverage;
    el.levChip.textContent = '杠杆 ' + L + 'x';
    if (L <= 1 || s.marginRatio === null) {
      el.mbVal.textContent = '∞';
      el.mbFill.style.width = '100%';
      el.mbFill.className = 'mb-fill';
    } else {
      const r = Math.max(0, Math.min(500, s.marginRatio));
      el.mbVal.textContent = r.toFixed(1) + '%';
      el.mbFill.style.width = (r / 500 * 100) + '%';
      el.mbFill.className = 'mb-fill ' + (r <= 100 ? 'danger' : (r <= 160 ? 'warn' : ''));
    }
    /* 可买/可卖副标题 */
    el.buySub.textContent = '可用 ' + money(s.avail);
    const p = Game.pos(S.code);
    el.sellSub.textContent = '可卖 ' + (p ? Game.canSellShares(S.code) : 0) + ' ' + unitOf(S.code);

    /* 质押负债 / 民间借贷 / 信用 / 现金理财 */
    if (el.debtChip) {
      const parts = [];
      if (s.debtTotal > 0) parts.push('负债 ' + money(s.debtTotal) +
        ' · 日息 ' + money(s.debtTotal * (s.loanRate / 252)));
      if (s.illDebt > 0) parts.push('⚠民间借贷 ' + money(s.illDebt));
      if (s.civDebt > 0) parts.push('信贷/亲友 ' + money(s.civDebt));
      if (s.creditBad) parts.push('失信 ' + Math.round(s.credit) + '分');
      if (parts.length) {
        el.debtChip.classList.remove('hidden');
        el.debtChip.classList.toggle('danger-chip', s.illDebt > 0 || s.civDebt > 0 || s.creditBad);
        el.debtChip.textContent = parts.join(' | ');
      } else el.debtChip.classList.add('hidden');
    }
    /* 理财类资产合计 (逆回购 + 银行理财 + 养老金 + 保险现金价值) */
    if (el.cashChip) {
      const parts = [];
      if (s.repoVal > 0) parts.push('逆回购 ' + money(s.repoVal));
      if (s.wealthVal > 0) parts.push('理财 ' + money(s.wealthVal));
      if (s.pensionVal > 0) parts.push('养老金 ' + money(s.pensionVal));
      if (s.insureCV > 0) parts.push('保险现价 ' + money(s.insureCV));
      if (s.cashFund) parts.push('现金宝 ON');
      if (parts.length) {
        el.cashChip.classList.remove('hidden');
        el.cashChip.textContent = '💰 ' + parts.join(' · ');
      } else el.cashChip.classList.add('hidden');
    }
    /* 操作的反作用力: 蝴蝶效应 / 融券费 / 冲击成本累计 */
    if (el.riskChip) {
      const parts = [];
      if (s.butterfly > 0.001) parts.push('蝴蝶 ' + Math.round(s.butterfly * 100) + '%');
      if (s.hindsight > 0) parts.push('后视镜 ' + s.hindsight + ' 次');
      if (Game.G.shortFee > 0) parts.push('融券费 ' + money(Game.G.shortFee));
      const slipSum = Object.keys(Game.G.impact || {}).reduce((a, k) => a + Game.G.impact[k], 0);
      if (slipSum > 0.5) parts.push('冲击 ' + money(slipSum));
      if (parts.length) {
        el.riskChip.classList.remove('hidden');
        el.riskChip.classList.toggle('hot', s.butterfly > 0.2);
        el.riskChip.textContent = '⚡ ' + parts.join(' · ');
        el.riskChip.title = '蝴蝶效应：你越是「照着后视镜」下单，未来的价格就越会偏离历史。' +
          (s.butterfly > 0 ? ' 当前扰动 ' + (s.butterfly * 100).toFixed(1) + '%。' : '');
      } else el.riskChip.classList.add('hidden');
    }
  }

  function renderFoot() {
    /* 中毒度 + 成就 */
    const a = Math.round(Game.G.addic);
    if (el.addFill) el.addFill.style.width = a + '%';
    if (el.addTxt) el.addTxt.textContent = '中毒度 ' + a + '%';
    if (el.badges) {
      el.badges.innerHTML = Game.BADGES.map(b =>
        `<span class="bg-chip ${Game.G.badges[b.id] ? 'got' : ''}" title="${Game.G.badges[b.id] ? '已解锁' : '未解锁'}">${b.name}</span>`
      ).join('');
    }
    const s = Game.summary();
    const winRate = (Game.G.wins + Game.G.losses) ? (Game.G.wins / (Game.G.wins + Game.G.losses) * 100).toFixed(0) : '--';
    if (el.statsMini) {
      const extra = [];
      if (s.butterfly > 0.001) extra.push('蝴蝶扰动 <b>' + (s.butterfly * 100).toFixed(0) + '%</b>');
      if (s.divTotal > 0) extra.push('累计分红 <b>' + money(s.divTotal) + '</b>');
      if (Game.G.cbWins.length) extra.push('中签 <b>' + Game.G.cbWins.length + '</b> 次');
      el.statsMini.innerHTML =
        `已交易 <b>${Game.G.totalBuys + Game.G.totalSells}</b> 次 · 胜率 <b>${winRate}%</b><br>
         最大回撤 <b>${num(Game.G.maxDrawdown, 1)}%</b> · 强平 <b>${Game.G.margins}</b> 次` +
        (extra.length ? '<br>' + extra.join(' · ') : '') +
        (s.cashAssets > 1 ? '<br>现金理财合计 <b>' + money(s.cashAssets) + '</b>' : '');
    }
    /* 战绩曲线 */
    drawEquity();
  }

  function drawEquity() {
    const h = Game.G.history;
    if (!h || h.length < 2) { ChartKit.equity(el.equityChart, null); return; }
    const base = h[0].bench || 1;
    ChartKit.equity(el.equityChart,
      h.map(x => x.eq),
      h.map(x => (x.bench / base) * (Game.G.base)),
      h.map(x => x.d));
  }

  /* ---------------- 图表 ---------------- */
  /* 影子价格: 图上的 K 线必须是玩家「实际面对」的价格,
     否则会出现「图上是 10 元、成交却在 9 元」的荒谬感 */
  let dateIdxMap = null;
  function dateIdx(d) {
    if (!dateIdxMap) {
      dateIdxMap = {};
      const arr = Market.dates;
      for (let i = 0; i < arr.length; i++) dateIdxMap[arr[i]] = i;
    }
    return dateIdxMap[d];
  }

  function shadowBars(code, bars, end) {
    if (!bars || !bars.length) return bars;
    if (!Game.G.opt || (!Game.G.opt.butterfly && !Game.G.opt.blackswan)) return bars;
    const globalEnd = (end === undefined) ? Market.idx : end;
    const n = bars.length;
    const first = globalEnd - n + 1;
    return bars.map((b, i) => {
      /* 日线: 直接按位置推进; 周线/聚合: 用日期反查全局下标 */
      let gi = first + i;
      const byDate = dateIdx(b.d);
      if (byDate !== undefined) gi = byDate;
      if (gi < 0) return b;
      const k = Game.kAt(code, gi);
      if (k === 1) return b;
      return Object.assign({}, b, {
        o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k,
        ma5: b.ma5 * k, ma10: b.ma10 * k, ma20: b.ma20 * k
      });
    });
  }

  function chartData() {
    const end = Market.idx - S.offset;
    if (S.view === 'week') return shadowBars(S.code, Market.agg(S.code, 'week', S.bars, end), end);
    const all = Market.series(S.code, S.bars + 60, end);
    return shadowBars(S.code, all.slice(-S.bars), end);
  }

  function drawChart() {
    if (!S.code) return;
    const p = Game.pos(S.code);
    const k = Game.kAt(S.code, Market.idx);
    if (S.view === 'minute') {
      if (Market.S.mode === 'live') {
        const id = Market.S.intraday[S.code];
        if (id && id.length) {
          ChartKit.minute(el.kchart, id.map(x => ({ p: x.p * k, v: x.v })), Market.prevClose(S.code) * k);
          return;
        }
      }
      const r = Market.restored(S.code, Market.idx);
      if (r) {
        ChartKit.minute(el.kchart, r.pts.map(x => ({ p: x.p * k, v: x.v })), r.prevClose * k,
          k === 1 ? '当日走势 (开高低收还原)' : '当日走势 · 已含扰动');
        return;
      }
      ChartKit.minute(el.kchart, null, 0, '暂无分时数据');
      return;
    }
    const bars = chartData();
    const opts = { showMA: true, cross: S.cross, costLine: p ? p.cost : null };
    S.layout = ChartKit.candles(el.kchart, bars, opts);
    S.layoutBars = bars;
  }

  function handleCross(e) {
    if (!S.layout || S.view === 'minute') { el.crosshair.classList.add('hidden'); return; }
    const rect = el.kchart.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const L = S.layout;
    const i = Math.round((x - L.padL) / L.step - 0.5);
    const bars = S.layoutBars || [];
    if (i < 0 || i >= bars.length) { el.crosshair.classList.add('hidden'); S.cross = null; drawChart(); return; }
    S.cross = { index: i };
    el.crosshair.classList.remove('hidden');
    el.crosshair.style.left = (L.X(i)) + 'px';
    el.crosshair.style.top = '0px';
    el.crosshair.style.height = rect.height + 'px';
    el.crosshair.style.borderBottom = 'none';
    const b = bars[i];
    el.crosshair.innerHTML = `<div class="box" style="left:${L.X(i) > rect.width / 2 ? '-132px' : '8px'};top:10px">
      日期 ${b.d}<br>开 ${num(b.o)} 高 ${num(b.h)}<br>低 ${num(b.l)} 收 ${num(b.c)}<br>
      量 ${ChartKit.kvol(b.v)}<br>
      <span style="color:var(--gold)">MA5 ${b.ma5 ? num(b.ma5) : '--'}</span>
    </div>`;
    drawChart();
  }

  /* ---------------- 交易面板 ---------------- */
  function syncCalc() {
    const price = parseFloat(el.priceInput.value) || 0;
    const qty = parseInt(el.qtyInput.value, 10) || 0;
    const amt = price * qty;
    el.calcAmt.textContent = money(amt, true);
    el.calcFee.textContent = money(Game.buyFee(amt, S.code), true);
    el.calcMargin.textContent = money(amt / Math.max(1, Game.G.leverage), true);
    /* 冲击成本: 按当前委托量与近期成交量中位数的占比估算滑点 */
    if (el.calcSlip) {
      if (qty > 0 && amt > 0) {
        const slip = Game.impactSlip(S.code, qty);
        el.calcSlip.textContent = (slip >= 0.0005 ? '≈' + (slip * 100).toFixed(2) + '% · ' : '') +
          money(amt * slip, true);
        const row = el.calcSlip.parentNode;
        if (row) row.classList.toggle('heavy', slip * 100 >= 0.8);
      } else {
        el.calcSlip.textContent = '—';
        const row = el.calcSlip.parentNode;
        if (row) row.classList.remove('heavy');
      }
    }
  }

  function fillPrice() {
    if (!S.code) return;
    const p = Game.px(S.code);
    if (p > 0) el.priceInput.value = p.toFixed(Market.isCB(S.code) ? 3 : 2);
    syncCalc();
  }

  function maxBuyable() {
    const s = Game.summary();
    const price = parseFloat(el.priceInput.value) || 0;
    const L = lotOf(S.code);
    if (price <= 0) return 0;
    const feeGuess = 0.001;
    let cash = s.avail * Game.G.leverage / (1 + Game.G.leverage * feeGuess * 0.1);
    if (Game.G.leverage <= 1) cash = (s.avail - (Market.isCB(S.code) ? 1 : 5)) / (1 + 0.00035);
    return Math.floor(cash / price / L) * L;
  }

  function doBuy() {
    const price = parseFloat(el.priceInput.value) || 0;
    const qty = parseInt(el.qtyInput.value, 10) || 0;
    const r = Game.buy(S.code, price, qty, S.direction);
    toast(r.msg, r.ok ? 'ok' : 'bad');
    if (r.ok) {
      if (S.direction === 'short')
        tempFace('eager', '融券卖出已成交。价格下跌即为盈利。', 2200, 'av-pop');
      else
        tempFace('eager', '买入已成交。请注意维持担保比例。', 2200, 'av-pop');
      Game.checkBadges();
    }
    refreshAll();
  }
  function doSell() {
    const price = parseFloat(el.priceInput.value) || 0;
    const qty = parseInt(el.qtyInput.value, 10) || 0;
    const r = Game.sell(S.code, price, qty);
    toast(r.msg, r.cls);
    if (r.ok) {
      const t = Game.G.trades[Game.G.trades.length - 1];
      const won = t && t.pnl >= 0;
      const shortClose = t && t.side === 'S_CLOSE';
      tempFace(won ? 'happy' : 'sad',
        won ? (shortClose ? '融券已平仓，本次结算为盈。' : '卖出成交，本次结算为盈。')
            : '卖出成交，本次结算为亏。请留意本金消耗。',
        2400, won ? 'av-pop' : 'av-shake');
      Game.checkBadges();
    }
    refreshAll();
  }

  function updateDirUI() {
    document.querySelectorAll('.dtab').forEach(t => {
      t.classList.toggle('active', t.dataset.dir === S.direction);
    });
    const bl = el.buyBtn && el.buyBtn.querySelector('.buy-label');
    const sl = el.sellBtn && el.sellBtn.querySelector('.sell-label');
    if (S.direction === 'short') {
      if (bl) bl.textContent = '卖 空 开 仓';
      if (sl) sl.textContent = '买 回 平 仓';
    } else {
      if (bl) bl.textContent = '买 入';
      if (sl) sl.textContent = '卖 出';
    }
  }

  /* ---------------- 全量刷新 ---------------- */
  let rafPending = false;
  function refreshAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateWatch();
      renderPos(); renderLog(); renderTop(); renderHud(); renderFoot();
      drawChart(); syncCalc(); refreshFace(); renderNews(); renderSwan();
    });
  }

  function select(code) {
    S.code = code;
    S.offset = 0;
    Object.keys(S.rows).forEach(c => {
      S.rows[c].node.classList.toggle('on', c === code);
    });
    if (S.rows[code] && S.rows[code].node.scrollIntoView) {
      S.rows[code].node.scrollIntoView({ block: 'nearest' });
    }
    fillPrice();
    renderTop(); drawChart();
    const p = Game.px(code);
    if (p > 0) el.priceInput.value = p.toFixed(Market.isCB(code) ? 3 : 2);
    el.qtyInput.value = 0;
    syncCalc();
  }

  /* ---------------- 退場演出 ---------------- */
  function showFx(face, word, sub, btnTxt) {
    el.fxAvatar.innerHTML = Char.face(face, { anim: 'av-shake' });
    el.fxWord.textContent = word;
    el.fxSub.innerHTML = sub;
    el.fxBtn.textContent = btnTxt || '重 新 开 始';
    el.fx.classList.remove('hidden');
  }
  function hideFx() { el.fx.classList.add('hidden'); }

  /* ================= 融资 · 信用 · 借贷中心 ================= */
  let loanTab = 'credit';
  function openModal(id) { const m = el[id]; if (m) m.classList.remove('hidden'); }
  function closeModal(id) { const m = el[id]; if (m) m.classList.add('hidden'); }

  const pctOf = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

  function civRow(l, i) {
    return `<div class="ill-row">
      <span>${l.icon} ${l.name}${l.overdue ? ' <em class="od">已逾期</em>' : ''}</span>
      <b class="${l.overdue ? 'down' : ''}">${money(l.owed)}</b>
      <input class="civRepayAmt" data-i="${i}" type="number" step="1000" value="0" placeholder="还款">
      <button class="btn btn-ghost sm civRepay" data-i="${i}">还款</button></div>`;
  }

  function renderLoan() {
    if (!el.loanBody) return;
    const s = Game.summary();
    document.querySelectorAll('.ltab').forEach(t => t.classList.toggle('active', t.dataset.lt === loanTab));
    let h = '';

    if (loanTab === 'credit') {
      const c = Math.round(s.credit);
      const band = c >= 700 ? 'good' : (c >= Game.CREDIT_BAD ? 'mid' : 'bad');
      const bandTxt = band === 'good' ? '良好' : band === 'mid' ? '一般' : '失信';
      h += `<div class="credit-card ${band}">
        <div class="cc-score"><span>信用分</span><b>${c}</b><em>${bandTxt}</em>
          <div class="cc-bar"><i style="width:${Math.max(0, Math.min(100, (c - 300) / 5.5))}%"></i></div>
        </div>
        <div class="cc-meta">
          <div><span>正规负债(质押+抵押)</span><b class="${s.debtTotal > 0 ? 'down' : ''}">${money(s.debtTotal)}</b></div>
          <div><span>可质押额度</span><b>${money(s.loanAvail)}</b></div>
          <div><span>资产可抵押额度</span><b>${money(s.mortAvail)}</b></div>
          <div><span>民间借贷欠款</span><b class="${s.illDebt > 0 ? 'down' : ''}">${money(s.illDebt)}</b></div>
          <div><span>消费信贷欠款</span><b class="${s.civDebt > 0 ? 'down' : ''}">${money(s.civDebt)}</b></div>
          <div><span>总负债</span><b class="${s.totalDebt > 0 ? 'down' : ''}">${money(s.totalDebt)}</b></div>
          <div><span>人情 / 关系</span><b class="${s.relation < 40 ? 'down' : ''}">${Math.round(s.relation)}</b></div>
          <div><span>累计被催收</span><b class="${Game.G.illCollected > 0 ? 'down' : ''}">${Game.G.illCollected} 次</b></div>
          <div><span>当前杠杆</span><b>${Game.G.leverage}x</b></div>
        </div>
      </div>`;
      const cb = Game.creditBlocked();
      if (cb) h += `<div class="warn-bar big">⚠ 高消费限制已生效<span>${cb}</span></div>`;
      h += `<div class="mini-note">信用分低于 ${Game.CREDIT_BAD} 触发失信惩戒：无法新开仓、无法新增借款。按时还款、降低负债率可逐步修复（负债清零时每日 +1）。</div>`;
    }

    if (loanTab === 'bank') {
      const rate = (Game.LOAN_RATE * 100).toFixed(0);
      h += `<div class="loan-sec">
        <div class="ls-hd">质押贷款 <span class="tag">正规 · 券商两融</span></div>
        <div class="ls-desc">以持仓市值质押借入现金，年化约 ${rate}%，按日计息。负债 ÷ 持仓市值低于 100% 将被强制平仓还贷。</div>
        <div class="ls-row">
          <div><span>可贷额度</span><b>${money(s.loanAvail)}</b></div>
          <div><span>当前负债</span><b>${money(s.debtTotal)}</b></div>
          <div><span>持仓市值</span><b>${money(s.mv)}</b></div>
        </div>
        <div class="ls-input">
          <input id="loanAmt" type="number" step="10000" value="0" placeholder="金额（元）">
          <button class="btn btn-primary sm" id="loanDoPledge">借入</button>
          <button class="btn btn-ghost sm" id="loanDoRepay">还款</button>
        </div>
      </div>
      <div class="loan-sec">
        <div class="ls-hd">现金理财 <span class="tag ${s.cashFund ? 'on' : ''}">${s.cashFund ? '已开启' : '已关闭'}</span></div>
        <div class="ls-desc">闲置资金自动买入货币基金，年化约 ${(Game.FUND_RATE * 100).toFixed(0)}%，按日计息，随时可用。</div>
        <button class="btn ${s.cashFund ? 'btn-ghost' : 'btn-primary'} sm" id="loanToggleFund">${s.cashFund ? '关闭理财' : '开启理财'}</button>
      </div>`;
    }

    if (loanTab === 'asset') {
      h += `<div class="mini-note">固定资产抵押：抵押率 ${(Game.MORT_LTV * 100).toFixed(0)}%，年化 ${(Game.MORT_RATE * 100).toFixed(0)}%。抵押金额计入总负债，利息按日累计。抵押资产在失信/极端催收下可能被强制处置。</div>`;
      (s.assets || []).forEach(a => {
        const avail = Math.max(0, a.value * Game.MORT_LTV - a.mort);
        h += `<div class="asset-card">
          <div class="ac-hd">${a.icon} ${a.name}</div>
          <div class="ac-meta"><span>估值 ${money(a.value, true)}</span><span>已抵押 ${money(a.mort)}</span><span>可抵押 <b>${money(avail)}</b></span></div>
          <div class="ls-input">
            <input class="assetAmt" data-id="${a.id}" type="number" step="10000" value="0" placeholder="金额（元）">
            <button class="btn btn-primary sm assetMort" data-id="${a.id}">抵押借入</button>
            <button class="btn btn-ghost sm assetRedeem" data-id="${a.id}">赎楼还款</button>
          </div></div>`;
      });
    }

    if (loanTab === 'consumer') {
      h += `<div class="mini-note">持牌消费信贷：合法，但年化普遍 16%–18%。花呗有免息期，借呗随借随还，信用卡取现按月复利且无免息期。逾期会<b>上报征信</b>。</div>`;
      Game.CONSUMER_CREDIT.forEach(p => {
        const apr = (p.compound ? (Math.pow(1 + p.daily, 365) - 1) : p.daily * 365) * 100;
        h += `<div class="cc-card">
          <div class="ic-hd">${p.icon} ${p.name} <span class="ic-apr">年化≈${apr.toFixed(1)}%</span></div>
          <div class="ic-desc">${p.desc}</div>
          <div class="ic-law">⚖ ${p.law}</div>
          <div class="ls-input">
            <input class="civAmt" data-id="${p.id}" type="number" step="1000" value="0" placeholder="金额（上限 ${money(p.limit)}）">
            <button class="btn btn-primary sm civDo" data-id="${p.id}">借入</button>
          </div></div>`;
      });
      const mine = (s.civLoans || []).map((l, i) => ({ l, i })).filter(x => x.l.kind === 'consumer');
      if (mine.length) {
        h += `<div class="loan-sec"><div class="ls-hd">我的消费信贷欠款</div>`;
        mine.forEach(x => { h += civRow(x.l, x.i); });
        h += `<div class="mini-note">按时还款可修复征信；逾期扣信用分并影响后续借贷。</div></div>`;
      }
    }

    if (loanTab === 'friend') {
      const rel = Math.round(s.relation);
      const rc = rel >= 70 ? 'good' : rel >= 40 ? 'mid' : 'bad';
      h += `<div class="credit-card ${rc}">
        <div class="cc-score"><span>人情 / 关系</span><b>${rel}</b>
          <em>${rel >= 70 ? '铁哥们' : rel >= 40 ? '一般' : '快凉了'}</em>
          <div class="cc-bar"><i style="width:${Math.max(0, Math.min(100, rel))}%"></i></div></div>
        <div class="mini-note" style="margin:0">亲友借款不收利息，但每拖一天都在消耗人情。按时还款——关系会更铁。</div>
      </div>`;
      Game.FRIEND_LOANS.forEach(p => {
        h += `<div class="friend-card">
          <div class="ic-hd">${p.icon} ${p.name} <span class="ic-apr">无息 · 人情 ${p.trust}</span></div>
          <div class="ic-desc">${p.desc}</div>
          <div class="ic-law">⚖ ${p.law}</div>
          <div class="ls-input">
            <input class="civAmt" data-id="${p.id}" type="number" step="1000" value="0" placeholder="金额（上限 ${money(p.limit)}）">
            <button class="btn btn-primary sm civDo" data-id="${p.id}">开口借</button>
          </div></div>`;
      });
      const mine2 = (s.civLoans || []).map((l, i) => ({ l, i })).filter(x => x.l.kind === 'friend');
      if (mine2.length) {
        h += `<div class="loan-sec"><div class="ls-hd">欠亲友的钱</div>`;
        mine2.forEach(x => { h += civRow(x.l, x.i); });
        h += `<div class="mini-note">亲友的钱最好借也最难还——还的是情分。趁早还，别把关系拖没了。</div></div>`;
      }
    }

    if (loanTab === 'ill') {
      h += `<div class="warn-bar big">⚠ 以下为<b>非法 / 不受法律保护</b>的借贷产品，仅作普法演示<span>年化远超一年期 LPR 四倍（约 13.8%）。“砍头息”“利滚利”“爆通讯录”均属违法，请勿在现实中触碰。</span></div>`;
      Game.ILLEGAL_LOANS.forEach(p => {
        const apr = (p.compound ? (Math.pow(1 + p.daily, 365) - 1) : p.daily * 365) * 100;
        h += `<div class="ill-card">
          <div class="ic-hd">${p.icon} ${p.name} <span class="ic-apr">年化≈${apr.toFixed(0)}%</span></div>
          <div class="ic-desc">${p.desc}</div>
          <div class="ic-law">⚖ ${p.law}</div>
          <div class="ls-input">
            <input class="illAmt" data-id="${p.id}" type="number" step="10000" value="0" placeholder="想借多少">
            <button class="btn btn-ill sm illDo" data-id="${p.id}">我要借 ⚠</button>
          </div></div>`;
      });
      if (s.illLoans && s.illLoans.length) {
        h += `<div class="loan-sec"><div class="ls-hd">我的民间借贷欠款</div>`;
        s.illLoans.forEach((l, i) => {
          h += `<div class="ill-row">
            <span>${l.icon} ${l.name}${l.overdue ? ' <em class="od">已逾期</em>' : ''}</span>
            <b class="down">${money(l.owed)}</b>
            <input class="illRepayAmt" data-i="${i}" type="number" step="10000" value="0" placeholder="还款">
            <button class="btn btn-ghost sm illRepay" data-i="${i}">还款</button></div>`;
        });
        h += `<div class="mini-note">欠款按日累加，逾期触发催收：短信轰炸 → 爆通讯录 → 上门并强制处置财产。及时还款、尽快上岸是唯一出路。</div></div>`;
      }
    }
    el.loanBody.innerHTML = h;
    bindLoanBody();
  }

  function bindLoanBody() {
    const q = id => el.loanBody.querySelector('#' + id);
    const g = id => q(id);
    if (g('loanDoPledge')) g('loanDoPledge').onclick = () => {
      const r = Game.pledge(+g('loanAmt').value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    };
    if (g('loanDoRepay')) g('loanDoRepay').onclick = () => {
      const r = Game.repay(+g('loanAmt').value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    };
    if (g('loanToggleFund')) g('loanToggleFund').onclick = () => { Game.setCashFund(!Game.G.cashFund); renderLoan(); refreshAll(); };

    el.loanBody.querySelectorAll('.assetMort').forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      const inp = el.loanBody.querySelector('.assetAmt[data-id="' + id + '"]');
      const r = Game.mortgage(id, +inp.value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    });
    el.loanBody.querySelectorAll('.assetRedeem').forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      const inp = el.loanBody.querySelector('.assetAmt[data-id="' + id + '"]');
      const r = Game.redeem(id, +inp.value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    });
    el.loanBody.querySelectorAll('.illDo').forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      const p = Game.ILLEGAL_LOANS.find(x => x.id === id);
      const inp = el.loanBody.querySelector('.illAmt[data-id="' + id + '"]');
      if (!window.confirm('⚠ 这是违法借贷！\n\n' + p.desc + '\n\n法律提示：' + p.law + '\n\n本作仅为普法演示，确定要借吗？')) return;
      const r = Game.borrowIllegal(id, +inp.value || 0); toast(r.msg, r.ok ? 'warn' : 'bad');
      if (r.ok) { tempFace('worry', '该产品不属于持牌借贷，请先看清利率与期限。', 3200, 'av-shake'); renderLoan(); refreshAll(); }
    });
    el.loanBody.querySelectorAll('.illRepay').forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      const inp = el.loanBody.querySelector('.illRepayAmt[data-i="' + i + '"]');
      const r = Game.repayIllegal(i, +inp.value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    });
    /* 花呗/借呗/信用卡 + 亲友借款 */
    el.loanBody.querySelectorAll('.civDo').forEach(b => b.onclick = () => {
      const id = b.dataset.id;
      const inp = el.loanBody.querySelector('.civAmt[data-id="' + id + '"]');
      const r = Game.borrowCivil(id, +inp.value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    });
    el.loanBody.querySelectorAll('.civRepay').forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      const inp = el.loanBody.querySelector('.civRepayAmt[data-i="' + i + '"]');
      const r = Game.repayCivil(i, +inp.value || 0); toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderLoan(); refreshAll(); }
    });
  }

  function openLoanModal() { openModal('loanModal'); renderLoan(); refreshAll(); }

  /* ================= 玩法设置 ================= */
  function renderSet() {
    if (!el.setBody) return;
    const o = Game.G.opt || Game.DEF_OPT;
    const items = [
      ['blackswan', '黑天鹅事件', '默认开启',
        '在真实历史路径之外，按概率注入宏观/行业级冲击事件（信用违约、地缘冲突、流动性枯竭、闪崩连锁、政策宽松…）。' +
        '事件通过「影子价格」作用于市场，不修改任何真实历史数据，存盘后可复现。关闭后历史走势与原数据完全一致。'],
      ['butterfly', '反后视镜蝴蝶效应', '默认开启',
        '当你在「历史高胜率」点位反复下单、走势与历史高度吻合时，市场会逐步对该标的施加逆向随机扰动——' +
        '模拟策略拥挤导致规律失效。强度随命中次数累积。'],
      ['impact', '订单冲击成本', '默认开启',
        '单笔委托相对该标的近期成交量越大，成交均价越差（平方根律，单边上限 2.5%）。' +
        '这会让「一把梭」大单付出真实的代价。'],
      ['shortFee', '融券借券费', '默认开启',
        '持有空单期间，按持仓市值的年化 8% 逐日计提借券费用。做空不再是「免费方向」。'],
      ['divTax', '股息红利差别化个税', '默认开启',
        '持股 ≤1 个月税负 20%、1 个月–1 年 10%、超过 1 年免征。派发时不预扣，卖出时按先进先出逐笔补缴。'],
      ['news', 'RSS 滚动快讯条', '默认开启',
        '顶部滚动条混合展示「当日盘面实时播报」与真实 RSS 财经快讯。关闭后隐藏。']
    ];
    let h = '';
    items.forEach(([k, name, tag, desc]) => {
      const on = o[k] !== false;
      h += `<div class="set-row ${on ? '' : 'off'}">
        <div class="sr-txt"><b>${name}<em>${tag}</em></b><p>${desc}</p></div>
        <button class="switch ${on ? 'on' : ''}" data-opt="${k}" aria-label="${name}"><i></i></button>
      </div>`;
    });
    /* 黑天鹅频率 */
    const lv = o.swanLevel === undefined ? 3 : o.swanLevel;
    h += `<div class="set-row">
      <div class="sr-txt"><b>黑天鹅频率<em>默认「正常」</em></b>
        <p>控制事件抽取概率。档位越高，市场越像真实世界里那个「不平静」的样子。</p>
        <div class="lvl-row">` +
      Game.SWAN_LEVELS.map(x =>
        `<button class="lvl-btn ${lv === x.v ? 'on' : ''}" data-lvl="${x.v}">${x.name}</button>`).join('') +
      `</div><div class="lvl-note">${(Game.SWAN_LEVELS[lv] || {}).note || ''}</div></div>
    </div>`;
    /* 已发生事件 */
    h += `<div class="law-warn">📜 本局已发生的黑天鹅事件（${(Game.G.swanLog || []).length}）</div>`;
    if (!(Game.G.swanLog || []).length) {
      h += `<div class="mini-note">尚未发生。历史上每一次「这次不一样」，最后都变成了「又来了」。</div>`;
    } else {
      Game.G.swanLog.slice(0, 12).forEach(s => {
        h += `<div class="swan-item ${s.kind}">
          <div class="sh"><b>${s.kind === 'bear' ? '📉' : '📈'} ${s.name}</b>
            <span class="when">${s.day}</span></div>
          <div>${s.t}</div></div>`;
      });
    }
    /* 当前生效 */
    const act = Game.activeSwans();
    if (act.length) {
      h += `<div class="law-warn">⚡ 当前生效中（${act.length}）</div>`;
      act.forEach(s => { h += swanCard(s, true); });
    }
    el.setBody.innerHTML = h;
    bindSetBody();
  }

  function swanCard(s, live) {
    const total = s.days || 1;
    const done = Math.max(0, Math.min(total, Market.idx - s.startIdx));
    return `<div class="swan-item ${s.kind}">
      <div class="sh"><b>${s.kind === 'bear' ? '📉' : '📈'} ${s.name}</b>
        <span class="when">${s.day} 起 · ${total} 个交易日</span></div>
      <div>${s.t}</div>
      <div style="margin-top:4px;color:var(--ink-soft)">💡 ${s.tip}</div>
      ${live ? `<div class="life"><span>已持续 ${done}/${total}</span>
        <span class="bar"><i style="width:${Math.min(100, done / total * 100)}%"></i></span>
        <span>日均 ${(s.drift * 100).toFixed(2)}%</span></div>` : ''}
    </div>`;
  }

  function bindSetBody() {
    el.setBody.querySelectorAll('[data-opt]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.opt;
        const cur = (Game.G.opt || Game.DEF_OPT)[k] !== false;
        const r = Game.setOpt(k, !cur);
        toast(r.msg, 'ok');
        renderSet(); refreshAll();
      };
    });
    el.setBody.querySelectorAll('[data-lvl]').forEach(b => {
      b.onclick = () => {
        Game.setOpt('swanLevel', +b.dataset.lvl);
        toast('黑天鹅频率：' + Game.SWAN_LEVELS[+b.dataset.lvl].name, 'ok');
        renderSet();
      };
    });
  }
  function openSetModal() { openModal('setModal'); renderSet(); }

  /* ================= 现金管理 · 理财中心 ================= */
  let wTab = 'repo';
  function openWealthModal() { openModal('wealthModal'); renderWealth(); refreshAll(); }

  function wealthHead(s) {
    return `<div class="cb-stat">
      <div>可用资金<b>${money(s.avail)}</b></div>
      <div>逆回购<b>${money(s.repoVal)}</b></div>
      <div>银行理财<b>${money(s.wealthVal)}</b></div>
      <div>现金理财合计<b>${money(s.cashAssets)}</b></div>
    </div>`;
  }

  /* ---- 国债逆回购 ---- */
  function repoPane(s) {
    let h = `<div class="mini-note">国债逆回购：把闲钱按约定利率借给需要资金的机构，对方以国债质押，属交易所场内业务。沪深统一 <b>1,000 元起</b>、按 1,000 元整数倍申报。
      收益 = 金额 × 年化利率 × 占款天数 ÷ 365，手续费单向收取（1 天 0.001%…91/182 天 0.03%，30 元封顶），免印花税与过户费。到期本息自动回款，<b>不可提前赎回</b>。</div>`;

    if (s.repos.length) {
      const tot = s.repos.reduce((a, r) => a + r.amount, 0);
      h += `<div class="ls-hd">持有中 · ${s.repos.length} 笔 · 合计 ${money(tot)}</div>`;
      s.repos.slice().sort((a, b) => a.matureIdx - b.matureIdx).forEach(r => {
        const left = Math.max(0, r.matureIdx - Market.idx);
        const days = r.days || 1;
        const done = Math.max(0, Math.min(days, days - left));
        const interest = r.amount * (r.rate / 100) * (r.days / 365);
        const endDate = Market.dates[Math.min(r.matureIdx, Market.dates.length - 1)] || '—';
        h += `<div class="rp-hold">
          <div>${r.name} · 出借 <b>${money(r.amount)}</b> @ ${r.rate.toFixed(3)}% · ${r.days} 天</div>
          <div style="margin-top:3px">到期日 ${endDate} · 剩余 <b>${left}</b> 个交易日 · 预计利息 <b class="up">+${num(interest)}</b> 元 · 手续费 ${num(r.fee)} 元</div>
          <div class="bar"><i style="width:${Math.min(100, done / days * 100)}%"></i></div>
        </div>`;
      });
    } else {
      h += `<div class="mini-note">当前没有持有中的逆回购。闲置资金放在账上是没有利息的。</div>`;
    }

    h += `<div class="ls-row" style="margin:4px 0 8px">
        <div><span>可出借资金</span><b>${money(s.avail)}</b></div>
        <div><span>最大可投</span><b>${money(Math.floor(Math.max(0, s.avail) / 1000) * 1000)}</b></div>
      </div>
      <div class="ls-input" style="margin-bottom:10px">
        <input id="rpAmt" type="number" step="1000" min="1000" value="${Math.floor(Math.max(0, Math.min(s.avail, 50000)) / 1000) * 1000 || 1000}" placeholder="出借金额（1,000 元整数倍）">
        <span style="font-size:11px;font-weight:800;color:var(--ink-soft)">填好金额后，点下方任一期限即可下单</span>
      </div>`;

    const mk = (title, sub, list) => {
      let x = `<div class="rp-col"><h4>${title} <span>${sub}</span></h4>`;
      list.forEach(([code, label, days]) => {
        const rt = Market.price(code);
        const fee = Game.rpFeeOf(10000, days) / 10000 * 100;
        x += `<div class="rp-row">
          <span>${label}<span class="d"> ${code.slice(2)} · ${days}天</span></span>
          <span class="rt ${rt > 0 ? 'up' : 'flat'}">${rt > 0 ? rt.toFixed(3) + '%' : '—'}</span>
          <span class="fee">费 ${fee.toFixed(4)}%</span>
          <button data-rp="${code}">出借</button>
        </div>`;
      });
      return x + `</div>`;
    };
    const sh = [
      ['sh204001', 'GC001', 1], ['sh204002', 'GC002', 2], ['sh204003', 'GC003', 3],
      ['sh204004', 'GC004', 4], ['sh204007', 'GC007', 7], ['sh204014', 'GC014', 14],
      ['sh204028', 'GC028', 28], ['sh204091', 'GC091', 91], ['sh204182', 'GC182', 182]
    ];
    const sz = [
      ['sz131810', 'R-001', 1], ['sz131811', 'R-002', 2], ['sz131800', 'R-003', 3],
      ['sz131809', 'R-004', 4], ['sz131801', 'R-007', 7], ['sz131802', 'R-014', 14],
      ['sz131803', 'R-028', 28], ['sz131805', 'R-091', 91], ['sz131806', 'R-182', 182]
    ];
    h += `<div class="rp-grid">` + mk('沪市 GC 系列', '上交所 · 国债逆回购', sh) +
      mk('深市 R- 系列', '深交所 · 国债逆回购', sz) + `</div>`;
    return h;
  }

  /* ---- 银行理财 ---- */
  function wmSpark(code) {
    const bars = Market.series(code, 60, Market.idx);
    if (bars.length < 2) return '';
    const vs = bars.map(b => b.c);
    const mn = Math.min.apply(null, vs), mx = Math.max.apply(null, vs);
    const rg = (mx - mn) || 1;
    const W = 300, H = 34;
    const pts = vs.map((v, i) =>
      `${(i / (vs.length - 1) * W).toFixed(1)},${(H - (v - mn) / rg * (H - 4) - 2).toFixed(1)}`).join(' ');
    const rise = vs[vs.length - 1] >= vs[0];
    return `<div class="wm-spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%">
      <polyline points="${pts}" fill="none" stroke="${rise ? '#c8382c' : '#158a5b'}" stroke-width="2.4"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div>`;
  }

  function wmPane(s) {
    let h = `<div class="mini-note">资管新规后银行理财全面<b>净值化</b>，不再承诺保本保收益。风险等级 R1（谨慎）→ R5（激进），
      购买前须做风险测评，且只能买不高于自身承受等级的产品。净值会下跌，可能亏损本金。</div>`;
    Market.meta.filter(m => m.market === 'wm').forEach(m => {
      const p = Game.wealthProduct(m.code);
      if (!p) return;
      const nav = Market.price(m.code);
      const held = s.wealth.filter(w => w.code === m.code);
      const heldSh = held.reduce((a, w) => a + w.shares, 0);
      const heldVal = heldSh * nav;
      const cost = held.reduce((a, w) => a + w.cost, 0);
      const pnl = heldVal - cost;
      const capLeft = Math.max(0, p.info.cap - heldVal);
      const first = Market.series(m.code, 2, Market.idx);
      const dr = (first.length === 2 && first[0].c) ? (first[1].c / first[0].c - 1) * 100 : 0;
      h += `<div class="wm-card">
        <div class="wm-hd">
          <span class="risk-pill ${p.level.toLowerCase()}">${p.level} ${p.info.risk}风险</span>
          <span>${m.name}</span>
          <span class="wm-nav">净值 ${nav.toFixed(4)} <span class="${cls(dr)}">${pct(dr)}</span></span>
        </div>
        <div class="wm-desc">${p.info.desc}<br>风险等级：<b>${p.level} ${p.info.name}</b> · 单只持有上限 ${money(p.info.cap)} · 起购 ${money(Game.WM_MIN)}</div>
        ${wmSpark(m.code)}`;
      if (held.length) {
        h += `<div class="wm-hold">
          <span>持有 <b>${money(heldVal)}</b></span>
          <span>成本 ${money(cost)}</span>
          <span>浮动盈亏 <b class="${cls(pnl)}">${pnl >= 0 ? '+' : ''}${num(pnl)}</b></span>
          <input class="wmRedeemAmt" data-code="${m.code}" type="number" step="1000" value="0" placeholder="赎回金额（留空=全部）">
          <button class="btn btn-ghost sm wmRedeem" data-code="${m.code}">赎回</button>
        </div>`;
      }
      h += `<div class="ls-input">
          <input class="wmAmt" data-code="${m.code}" type="number" step="1000" value="0" placeholder="申购金额（剩余额度 ${money(capLeft)}）">
          <button class="btn btn-primary sm wmBuy" data-code="${m.code}">申购</button>
          ${capLeft <= 0 ? '<span style="font-size:11px;font-weight:800;color:var(--red)">已达单只上限</span>' : ''}
        </div>
        <div class="mini-note" style="margin:8px 0 0">⚖ ${p.info.desc}</div>
      </div>`;
    });
    return h;
  }

  /* ---- 可转债打新 ---- */
  function cbPane(s) {
    const banned = s.cbBanned;
    let h = `<div class="mini-note">可转债打新采用<b>信用申购</b>：申购时无需预缴资金、零成本，中签后按面额缴款（1 手 = 10 张 = 1,000 元面额）。
      连续 12 个月内累计<b>弃购 3 次</b>，将在 6 个月内不得参与新股、可转债、可交换债申购。上市首日涨跌幅限制 +57.3% / −43.3%。</div>`;

    if (banned) {
      h += `<div class="warn-bar big">⚠ 申购禁令生效中<span>还有 ${Math.max(0, s.cbBanUntil - Market.idx)} 个交易日不得参与申购（弃购 ${s.cbForfeit} 次）</span></div>`;
    } else if (s.cbForfeit > 0) {
      h += `<div class="warn-bar big">⚠ 已有 ${s.cbForfeit} 次弃购记录<span>累计 3 次将触发 6 个月申购禁令，中签后请务必备足资金。</span></div>`;
    }

    const wins = (Game.G.cbWins || []);
    const totalPnl = wins.reduce((a, w) => a + w.pnl, 0);
    h += `<div class="cb-stat">
      <div>待公布<b>${s.cbApplies.length}</b></div>
      <div>累计中签<b>${wins.length} 次</b></div>
      <div>打新盈亏<b class="${cls(totalPnl)}">${totalPnl >= 0 ? '+' : ''}${num(totalPnl)}</b></div>
      <div>弃购次数<b class="${s.cbForfeit > 0 ? 'down' : ''}">${s.cbForfeit}</b></div>
    </div>`;

    h += `<div class="loan-sec">
      <div class="ls-hd">信用申购 <span class="tag">零成本 · 中签才缴款</span></div>
      <div class="ls-desc">输入申购手数（1~100 手），收盘后公布中签结果。中签后按 1,000 元/手缴款。</div>
      <div class="ls-input">
        <input id="cbLots" type="number" step="1" min="1" max="100" value="10" placeholder="申购手数">
        <button class="btn btn-primary sm" id="cbApplyBtn" ${banned ? 'disabled style="opacity:.5"' : ''}>申 购</button>
      </div>
    </div>`;

    if (s.cbApplies.length) {
      h += `<div class="ls-hd">待公布结果</div>`;
      s.cbApplies.forEach(a => {
        h += `<div class="cb-pend">${a.day} 申购 ${a.lots} 手 · 需备缴款资金 ${money(a.lots * Game.CB_LOT * Game.CB_FV)}</div>`;
      });
    }
    if (wins.length) {
      h += `<div class="ls-hd">中签记录</div>`;
      wins.slice().reverse().forEach(w => {
        h += `<div class="cb-win"><span>${w.day}</span><span>${w.lots} 手</span>
          <span class="${cls(w.ret)}">首日 ${w.ret >= 0 ? '+' : ''}${w.ret.toFixed(2)}%</span>
          <span class="amt ${cls(w.pnl)}">${w.pnl >= 0 ? '+' : ''}${money(w.pnl)}</span></div>`;
      });
    }

    h += `<div class="ls-hd" style="margin-top:12px">可转债行情 <span class="tag">T+0 · 免印花税</span></div>
      <div class="mini-note" style="margin-bottom:8px">可转债实行 T+0，当日买入当日可卖；以 100 元面值/张报价，1 手 = 10 张。交易仅收佣金（万 2、最低 1 元），
      不收印花税与过户费。⚠ 含强制赎回条款：正股价格持续高于转股价一定幅度时，发行人可按面值加利息强赎，在 130 元高位买入可能瞬间巨亏。</div>`;
    Market.meta.filter(m => m.market === 'cb').forEach(m => {
      const c = Game.pxChg(m.code);
      const li = Market.listIdx(m.code);
      const fd = (li >= 0 && li >= Market.idx - 3);
      h += `<div class="cb-card">
        <div class="nm"><b>${m.name}</b><i>${m.code.slice(2)} · ${m.ind}${fd ? ' · 新上市' : ''}</i></div>
        <div style="text-align:right"><b>${num(c.now || Market.price(m.code), 2)}</b>
          <span class="${cls(c.pct)}" style="margin-left:7px">${pct(c.pct)}</span></div>
        <button class="btn btn-ghost sm cbGo" data-code="${m.code}">去交易</button>
      </div>`;
    });
    return h;
  }

  /* ---- 指数基金定投 ---- */
  function dcaPane(s) {
    let h = `<div class="mini-note">定投计划仅支持<b>场内基金（ETF / LOF）</b>。每 N 个交易日自动买入固定金额，忽略短期波动、摊平成本——
      本质是用纪律对抗择时冲动。资金不足时当期自动跳过并记录。</div>`;
    if (s.dca.length) {
      h += `<div class="ls-hd">进行中的计划 · ${s.dca.length}</div>`;
      s.dca.forEach(d => {
        const left = Math.max(0, d.every - (Market.idx - d.lastIdx));
        const nav = Game.px(d.code);
        h += `<div class="dca-plan">
          <span>${d.name}</span>
          <span>每 <b>${d.every}</b> 日 <b>${money(d.amount)}</b></span>
          <span>已投 <b>${d.count}</b> 期 / 累计 <b>${money(d.total)}</b></span>
          <span>${left === 0 ? '<b class="up">本期待执行</b>' : '距下期 ' + left + ' 个交易日'}</span>
          <span style="margin-left:auto">现价 ${num(nav, 3)}</span>
          <button class="btn btn-ghost sm dcaCancel" data-code="${d.code}">终止</button>
        </div>`;
      });
    }
    const fds = Market.meta.filter(m => m.market === 'fd' && m.tradable);
    h += `<div class="ls-hd" style="margin-top:12px">设置新计划</div>
      <div class="mini-note" style="margin-bottom:8px">选择标的 → 填写每期金额与间隔交易日 → 点「开始定投」。同一标的重复设置会覆盖原计划。</div>
      <div class="dca-row dca-head">
        <span>标的</span><span>每期金额</span><span>间隔(交易日)</span><span></span></div>`;
    fds.slice(0, 40).forEach(m => {
      const c = Game.pxChg(m.code);
      h += `<div class="dca-row" data-code="${m.code}">
        <div class="nm"><b>${m.name}</b><i>${m.code.slice(2)} · ${m.ind} · ${num(c.now, 3)} <span class="${cls(c.pct)}">${pct(c.pct)}</span></i></div>
        <input class="dcaAmt" data-code="${m.code}" type="number" step="100" value="1000" placeholder="金额">
        <input class="dcaEvery" data-code="${m.code}" type="number" step="1" min="1" max="60" value="5" placeholder="间隔">
        <button class="btn btn-primary sm dcaSet" data-code="${m.code}">开始定投</button>
      </div>`;
    });
    return h;
  }

  /* ---- 保险 / 养老金 ---- */
  function insPane(s) {
    let h = `<div class="mini-note"><b>保险姓保。</b>保障型产品（定期寿险）的作用是转移风险，现金价值极低，早期退保损失巨大；
      年金险锁定期长、流动性差，但现金价值会随时间爬升并每年返还。<b>先配足保障，再谈理财。</b></div>`;
    Game.INSURANCE.forEach(p => {
      const mine = s.insures.filter(i => i.pid === p.id);
      h += `<div class="cc-card">
        <div class="ic-hd">${p.icon} ${p.name} <span class="ic-apr">${p.kind} · 保费 ${money(p.premium)}</span></div>
        <div class="ic-desc">${p.desc}</div>
        <div class="ic-law">⚖ ${p.law}</div>`;
      if (mine.length) {
        mine.forEach(ins => {
          const i = Game.G.insures.indexOf(ins);
          h += `<div class="wm-hold">
            <span>已缴 <b>${money(ins.contributed)}</b></span>
            <span>现金价值 <b>${money(ins.cashValue)}</b></span>
            ${ins.benefits > 0 ? `<span>已领年金 <b class="up">${money(ins.benefits)}</b></span>` : ''}
            <button class="btn btn-ghost sm insSur" data-i="${i}">退保（损失 ${money(Math.max(0, ins.contributed - ins.benefits - ins.cashValue))}）</button>
          </div>`;
        });
      }
      h += `<div class="ls-input"><button class="btn btn-primary sm insBuy" data-pid="${p.id}">投保</button>
        <span style="font-size:11px;font-weight:800;color:var(--ink-soft)">可用 ${money(s.avail)}</span></div>
      </div>`;
    });

    const P = s.pension;
    const used = P.contributed || 0;
    const left = Math.max(0, Game.PENSION_CAP - used);
    h += `<div class="loan-sec">
      <div class="ls-hd">个人养老金账户 <span class="tag ${used > 0 ? 'on' : ''}">${used > 0 ? '已开通缴费' : '未缴费'}</span></div>
      <div class="ls-desc">每年缴费上限 ${money(Game.PENSION_CAP)} 元，缴费当期可在综合所得中据实扣除、享受个税优惠（本作按 ${(Game.PENSION_TAX * 100).toFixed(0)}% 档简化），
      账户内稳健增值约 ${(0.03 * 100).toFixed(0)}%/年，投资收益暂不征税。代价是资金封闭运行、流动性锁定。</div>
      <div class="ls-row">
        <div><span>本年度已缴</span><b>${money(used)}</b></div>
        <div><span>剩余额度</span><b>${money(left)}</b></div>
        <div><span>账户余额</span><b>${money(P.balance)}</b></div>
        <div><span>累计税优</span><b class="up">+${money(P.taxSaved)}</b></div>
      </div>
      <div class="ls-input">
        <input id="penAmt" type="number" step="1000" min="1000" value="0" placeholder="缴费金额（上限 ${money(left)}）">
        <button class="btn btn-primary sm" id="penPay">缴 费</button>
        <button class="btn btn-ghost sm" id="penOut">提前支取（需退回税优）</button>
      </div>
    </div>`;
    return h;
  }

  /* ---- 分红日历 ---- */
  function divPane(s) {
    let h = `<div class="mini-note">上市公司派发现金红利时，会在除权除息日对股价作相应下调——<b>分红不是白拿的钱</b>，持仓市值下降、现金增加，总资产基本不变。
      股息红利适用差别化个税：持股 ≤1 个月税负 20%、1 个月–1 年 10%、超过 1 年免征；派发时不预扣，卖出时按<b>先进先出</b>逐笔补缴。</div>`;
    h += `<div class="div-tax-grid">
      <div>持股 ≤1 个月<b class="down">20%</b></div>
      <div>1 个月 – 1 年<b>10%</b></div>
      <div>持股 &gt;1 年<b class="up">免征</b></div>
    </div>`;
    h += `<div class="cb-stat">
      <div>累计分红<b class="up">${money(s.divTotal)}</b></div>
      <div>已补缴红利税<b class="${s.divTax > 0 ? 'down' : ''}">${money(s.divTax)}</b></div>
      <div>分红笔数<b>${(Game.G.divLog || []).length}</b></div>
      <div>当前除权中<b>${Market.dividendsOn().length}</b></div>
    </div>`;

    /* 我的分红记录 */
    h += `<div class="ls-hd">我的分红记录</div>`;
    if (!(Game.G.divLog || []).length) h += `<div class="mini-note">还没有收到过分红。持有高股息标的并跨越其除权日即可获得派现。</div>`;
    else {
      h += `<div class="div-cal">`;
      Game.G.divLog.slice(0, 30).forEach(d => {
        h += `<div class="div-row"><span class="dt">${d.day.slice(5)}</span>
          <span class="nm">${d.name}<i style="font-style:normal;color:var(--ink-soft)"> ${d.code.slice(2)}</i></span>
          <span style="color:var(--ink-soft);font-size:10.5px">每股 ${d.perShare.toFixed(4)}</span>
          <span class="amt up">+${money(d.cash)}</span></div>`;
      });
      h += `</div>`;
    }

    /* 全市场除权日历 */
    h += `<div class="ls-hd" style="margin-top:12px">除权日历 <span class="tag">全部 ${Market.divcal.length} 条</span></div>`;
    const mine = {};
    Game.G.positions.forEach(p => { mine[p.code] = p; });
    const up = Market.divcal.filter(e => {
      const gi = Market.dates.indexOf(e.d);
      return gi > Market.idx && gi <= Market.idx + 30;
    }).sort((a, b) => Market.dates.indexOf(a.d) - Market.dates.indexOf(b.d));
    const past = Market.divcal.filter(e => Market.dates.indexOf(e.d) <= Market.idx)
      .sort((a, b) => Market.dates.indexOf(b.d) - Market.dates.indexOf(a.d)).slice(0, 40);

    if (up.length) {
      h += `<div class="mini-note">未来 30 个交易日将除权除息（持股可获得派现）</div><div class="div-cal">`;
      up.slice(0, 30).forEach(e => {
        const m = Market.metaOf(e.c) || { name: e.c };
        h += `<div class="div-row"><span class="dt">${e.d.slice(5)}</span>
          <span class="nm">${m.name}${mine[e.c] ? ' <b class="up">持仓中</b>' : ''}</span>
          <span style="color:var(--ink-soft);font-size:10.5px">预计每股 ${e.s.toFixed(4)}</span>
          ${mine[e.c] ? `<span class="amt up">预计 +${money(mine[e.c].shares * e.s)}</span>` : '<span class="amt" style="color:var(--ink-soft)">—</span>'}</div>`;
      });
      h += `</div>`;
    }
    if (past.length) {
      h += `<div class="mini-note" style="margin-top:10px">近期已实施的除权除息</div><div class="div-cal">`;
      past.forEach(e => {
        const m = Market.metaOf(e.c) || { name: e.c };
        h += `<div class="div-row"><span class="dt">${e.d.slice(5)}</span>
          <span class="nm">${m.name}</span>
          <span style="color:var(--ink-soft);font-size:10.5px">每股派现 ${e.s.toFixed(4)}</span>
          <span class="amt" style="color:var(--ink-soft)">已实施</span></div>`;
      });
      h += `</div>`;
    }
    if (!up.length && !past.length) h += `<div class="mini-note">数据包中暂未识别到除权事件。</div>`;
    return h;
  }

  function renderWealth() {
    if (!el.wealthBody) return;
    const s = Game.summary();
    document.querySelectorAll('.wtab').forEach(t => t.classList.toggle('active', t.dataset.wt === wTab));
    let h = wealthHead(s);
    if (wTab === 'repo') h += repoPane(s);
    else if (wTab === 'wm') h += wmPane(s);
    else if (wTab === 'cb') h += cbPane(s);
    else if (wTab === 'dca') h += dcaPane(s);
    else if (wTab === 'ins') h += insPane(s);
    else if (wTab === 'div') h += divPane(s);
    el.wealthBody.innerHTML = h;
    bindWealthBody();
  }

  function bindWealthBody() {
    const B = el.wealthBody;
    const q = sel => B.querySelector(sel);

    B.querySelectorAll('[data-rp]').forEach(b => b.onclick = () => {
      const amt = +((q('#rpAmt') || {}).value || 0);
      const r = Game.buyRepo(b.dataset.rp, amt);
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { tempFace('idle', '逆回购已成交，到期自动回款。', 2400, 'av-pop'); renderWealth(); refreshAll(); }
    });

    B.querySelectorAll('.wmBuy').forEach(b => b.onclick = () => {
      const code = b.dataset.code;
      const inp = B.querySelector('.wmAmt[data-code="' + code + '"]');
      const r = Game.buyWealth(code, +(inp.value || 0));
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) {
        const pr = Game.wealthProduct(code);
        tempFace(pr && pr.level === 'R5' ? 'worry' : 'idle',
          pr && pr.level === 'R5' ? 'R5 为最高风险等级，净值波动显著。' : '净值型产品，不保本不保收益。',
          3000, 'av-pop');
        renderWealth(); refreshAll();
      }
    });
    B.querySelectorAll('.wmRedeem').forEach(b => b.onclick = () => {
      const code = b.dataset.code;
      const inp = B.querySelector('.wmRedeemAmt[data-code="' + code + '"]');
      const r = Game.redeemWealth(code, +(inp.value || 0));
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    });

    const cbBtn = q('#cbApplyBtn');
    if (cbBtn) cbBtn.onclick = () => {
      const r = Game.cbApply(+((q('#cbLots') || {}).value || 0));
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    };
    B.querySelectorAll('.cbGo').forEach(b => b.onclick = () => {
      closeModal('wealthModal');
      S.zone = 'CB';
      document.querySelectorAll('.ztab').forEach(x => x.classList.toggle('active', x.dataset.zone === 'CB'));
      buildWatch(); select(b.dataset.code);
    });

    B.querySelectorAll('.dcaSet').forEach(b => b.onclick = () => {
      const code = b.dataset.code;
      const a = B.querySelector('.dcaAmt[data-code="' + code + '"]');
      const e = B.querySelector('.dcaEvery[data-code="' + code + '"]');
      const r = Game.setDca(code, +(a.value || 0), +(e.value || 0));
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    });
    B.querySelectorAll('.dcaCancel').forEach(b => b.onclick = () => {
      const r = Game.cancelDca(b.dataset.code);
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    });

    B.querySelectorAll('.insBuy').forEach(b => b.onclick = () => {
      const r = Game.buyInsurance(b.dataset.pid);
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { tempFace('worry', '早期退保损失较大，请确认后再操作。', 3000); renderWealth(); refreshAll(); }
    });
    B.querySelectorAll('.insSur').forEach(b => b.onclick = () => {
      if (!window.confirm('退保只能拿回现金价值，早期损失很大。确定退保？')) return;
      const r = Game.surrenderInsurance(+b.dataset.i);
      toast(r.msg, r.warn ? 'warn' : 'ok');
      renderWealth(); refreshAll();
    });
    const pp = q('#penPay');
    if (pp) pp.onclick = () => {
      const r = Game.pensionContribute(+((q('#penAmt') || {}).value || 0));
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    };
    const po = q('#penOut');
    if (po) po.onclick = () => {
      if (!window.confirm('个人养老金封闭运行，现实中须符合法定情形才能领取。提前支取需退回已享受的税收优惠。确定支取？')) return;
      const r = Game.pensionWithdraw();
      toast(r.msg, r.ok ? 'warn' : 'bad');
      if (r.ok) { renderWealth(); refreshAll(); }
    };
  }

  /* ================= 排行榜 ================= */
  function renderLb() {
    if (!el.lbBody) return;
    const list = Game.getLeaderboard();
    const s = Game.summary();
    let h = `<div class="lb-self">本次：收益率 <b class="${cls(s.returnPct)}">${pctOf(s.returnPct)}</b>
      · 净资产 ${money(s.equity, true)} · ${Game.G.mode === 'live' ? '实盘同步' : '历史回放'} · 杠杆 ${Game.G.leverage}x</div>`;
    if (!list.length) h += `<div class="empty">还没有任何记录。<br>点「记录本次成绩」上榜。</div>`;
    else {
      h += `<div class="lb-table">`;
      list.forEach((e, i) => {
        const mc = e.ret > 0 ? 'up' : (e.ret < 0 ? 'down' : 'flat');
        const rk = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
        h += `<div class="lb-row ${e.name === '你' ? 'me' : ''}">
          <span class="rk">${rk}</span><b>${e.name}</b>
          <span class="${mc}">${(e.ret >= 0 ? '+' : '') + e.ret.toFixed(2)}%</span>
          <em>${money(e.equity, true)} · ${e.lev}x · ${e.days}天 · ${e.date}</em></div>`;
      });
      h += `</div>`;
    }
    el.lbBody.innerHTML = h;
  }
  function openLbModal() { openModal('lbModal'); renderLb(); }

  /* ================= 金融普法 ================= */
  function renderLaw() {
    if (!el.lawBody) return;
    let h = `<div class="law-warn">⚖ 非法借贷的法律定性（本作仅为演示，切勿模仿）</div>`;
    Game.ILLEGAL_LOANS.forEach(p => {
      h += `<div class="law-card ill"><b>${p.icon} ${p.name}</b><p>${p.law}</p></div>`;
    });
    h += `<div class="law-warn">📖 金融法律常识</div><div class="law-grid">`;
    (Game.LEGAL_TIPS || []).forEach(t => { h += `<div class="law-card"><b>${t.t}</b><p>${t.b}</p></div>`; });
    h += `</div>`;
    el.lawBody.innerHTML = h;
  }
  function openLawModal() { openModal('lawModal'); renderLaw(); }

  function bind(map) {
    cache();
    /* 列表点击 */
    el.stockList.addEventListener('click', e => {
      const row = e.target.closest('.srow');
      if (row) select(row.dataset.code);
    });
    el.posList.addEventListener('click', e => {
      const row = e.target.closest('.prow');
      if (row) select(row.dataset.code);
    });
    el.searchInput.addEventListener('input', e => { S.filter = e.target.value; buildWatch(); });
    el.sortBtn.addEventListener('click', () => {
      const order = ['chg', 'price', 'name', 'code'];
      S.sort = order[(order.indexOf(S.sort) + 1) % order.length];
      buildWatch();
      toast('排序：' + { chg: '涨幅', price: '价格', name: '名称', code: '代码' }[S.sort]);
    });
    /* 图表切换 */
    document.querySelectorAll('.ctab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.ctab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        S.view = t.dataset.view;
        drawChart();
      });
    });
    /* 十字光标 */
    el.chartWrap.addEventListener('mousemove', handleCross);
    el.chartWrap.addEventListener('mouseleave', () => {
      el.crosshair.classList.add('hidden'); S.cross = null; drawChart();
    });
    /* 缩放 */
    el.chartWrap.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.deltaY < 0) S.bars = Math.max(24, S.bars - 8);
      else S.bars = Math.min(300, S.bars + 8);
      drawChart();
    }, { passive: false });

    /* 交易输入 (步长随交易单位变化: 可转债 10 张 / 其余 100 股) */
    const stepQty = d => {
      const L = lotOf(S.code);
      const v = (+el.qtyInput.value || 0) + d * L;
      el.qtyInput.value = Math.max(0, Math.round(v / L) * L);
      syncCalc();
    };
    document.getElementById('priceMinus').onclick = () => {
      const d = Market.isCB(S.code) ? 0.001 : 0.01;
      el.priceInput.value = (Math.max(d, (+el.priceInput.value || 0) - d)).toFixed(Market.isCB(S.code) ? 3 : 2);
      syncCalc();
    };
    document.getElementById('pricePlus').onclick = () => {
      const d = Market.isCB(S.code) ? 0.001 : 0.01;
      el.priceInput.value = ((+el.priceInput.value || 0) + d).toFixed(Market.isCB(S.code) ? 3 : 2);
      syncCalc();
    };
    document.getElementById('qtyMinus').onclick = () => stepQty(-1);
    document.getElementById('qtyPlus').onclick = () => stepQty(1);
    document.getElementById('priceMkt').onclick = fillPrice;
    el.priceInput.addEventListener('input', syncCalc);
    el.qtyInput.addEventListener('input', syncCalc);

    document.querySelectorAll('.qbtn').forEach(b => {
      b.addEventListener('click', () => {
        const q = b.dataset.q;
        if (q === 'clear') { el.qtyInput.value = 0; syncCalc(); return; }
        const L = lotOf(S.code);
        const mb = maxBuyable();
        const snap = v => Math.floor(v / L) * L;
        if (q === 'all') el.qtyInput.value = mb;
        if (q === 'half') el.qtyInput.value = snap(mb / 2);
        if (q === 'third') el.qtyInput.value = snap(mb / 3);
        if (q === 'quarter') el.qtyInput.value = snap(mb / 4);
        syncCalc();
      });
    });

    el.buyBtn.onclick = doBuy;
    el.sellBtn.onclick = doSell;
    el.closeAllBtn.onclick = () => {
      if (!Game.G.positions.length) { toast('现在是空仓'); return; }
      const out = Game.closeAll();
      toast('全部平仓，合计 ' + money(out.reduce((s, o) => s + o.pnl, 0)) + ' 元', 'warn');
      tempFace('zen', '已全部平仓。空仓等待也是一种仓位。', 2400);
      refreshAll();
    };
    el.clearLog.onclick = () => { Game.clearLog(); renderLog(); };

    /* 时间机器 */
    el.nextDayBtn.onclick = () => advance(1);
    el.next5Btn.onclick = () => advance(5);
    el.autoBtn.onclick = () => {
      if (S.auto) { clearInterval(S.auto); S.auto = null; el.autoBtn.textContent = '自动 ▶'; }
      else {
        S.auto = setInterval(() => advance(1), 900);
        el.autoBtn.textContent = '暂停 ‖';
      }
    };
    el.leverBtn.onclick = () => {
      if (window.__openLevModal) window.__openLevModal();
      else el.levModal.classList.remove('hidden');
    };
    el.restartBtn.onclick = () => location.reload();

    /* 分区标签 */
    document.querySelectorAll('.ztab').forEach(t => {
      t.addEventListener('click', () => {
        S.zone = t.dataset.zone;
        document.querySelectorAll('.ztab').forEach(x => x.classList.toggle('active', x === t));
        buildWatch();
      });
    });
    /* 多空切换 */
    document.querySelectorAll('.dtab').forEach(t => {
      t.addEventListener('click', () => {
        S.direction = t.dataset.dir;
        updateDirUI();
      });
    });
    updateDirUI();

    /* 融资 / 理财 / 排行榜 / 普法 / 设置 弹窗 */
    el.loanBtn.onclick = openLoanModal;
    document.querySelectorAll('.ltab').forEach(t => t.onclick = () => { loanTab = t.dataset.lt; renderLoan(); });
    el.wealthBtn.onclick = openWealthModal;
    document.querySelectorAll('.wtab').forEach(t => t.onclick = () => { wTab = t.dataset.wt; renderWealth(); });
    el.lbBtn.onclick = openLbModal;
    if (el.lbRecord) el.lbRecord.onclick = () => { Game.recordRun('你'); renderLb(); toast('已记录本次成绩', 'ok'); };
    if (el.lbClear) el.lbClear.onclick = () => { Game.clearLeaderboard(); renderLb(); toast('排行榜已清空', 'warn'); };
    el.lawBtn.onclick = openLawModal;
    el.setBtn.onclick = openSetModal;
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
    ['loanModal', 'lbModal', 'lawModal', 'wealthModal', 'setModal'].forEach(id => {
      const m = el[id]; if (m) m.addEventListener('click', e => { if (e.target === m) closeModal(id); });
    });

    /* 快讯条开关 */
    applyNewsOpt();
    window.addEventListener('resize', () => { drawChart(); drawEquity(); });
    return map;
  }

  /* 快讯条显示/隐藏 (跟随设置) */
  function applyNewsOpt() {
    if (!el.newsBar) return;
    const on = !Game.G.opt || Game.G.opt.news !== false;
    el.newsBar.classList.toggle('hidden', !on);
    if (on) renderNews();
  }

  function advance(n) {
    if (Game.G.mode === 'live') { toast('实盘模式下时间是真实流动的', 'warn'); return; }
    const moved = Game.stepDay(n);
    if (!moved) {
      toast('已经走到数据尽头，游戏结束', 'warn');
      const s = Game.summary();
      if (!Game.G._recorded) { Game.G._recorded = true; Game.recordRun('你'); }
      Game.G._lastWords = Char.lineForState('zen');
      showFx(s.returnPct >= 0 ? 'smug' : 'broken',
        '结 算',
        `最终净资产 <b>${money(s.equity, true)}</b>　收益率 <b>${pct(s.returnPct)}</b><br>
         同期沪深300 ${pct((Market.benchLevel(Market.idx) / (Market.benchLevel(Game.G.startIdx) || 1) - 1) * 100)}<br>
         强平 ${Game.G.margins} 次 · 中毒度 ${Math.round(Game.G.addic)}%`, '再来一局');
      return;
    }
    Game.checkBadges();
    refreshAll();
    /* 异动提示 */
    const list = Game.G.positions.map(p => {
      const c = Game.pxChg(p.code);
      const meta = Market.metaOf(p.code);
      return { r: c.pct, name: meta ? meta.name : p.code };
    }).sort((a, b) => b.r - a.r);
    if (list.length) {
      const top = list[0], bad = list[list.length - 1];
      if (top.r >= 9.5) toast('🚀 ' + top.name + ' 涨停 ' + pct(top.r), 'ok');
      else if (bad.r <= -9.5) toast('💀 ' + bad.name + ' 跌停 ' + pct(bad.r), 'bad');
      else if (top.r >= 5) toast(top.name + ' ' + pct(top.r) + '，要不要加仓？', 'ok');
      else if (bad.r <= -6) toast(bad.name + ' ' + pct(bad.r) + '…还扛得住吗？', 'bad');
    }
  }

  return {
    bind, toast, refreshAll, select, buildWatch, updateWatch, renderPos, renderLog,
    renderTop, renderHud, renderFoot, drawChart, drawEquity, setFace, tempFace,
    refreshFace, showFx, hideFx, syncCalc, fillPrice, S, el, money, pct, cls, num,
    openLoanModal, openLbModal, openLawModal, renderLoan, renderLb, renderLaw, closeModal,
    openWealthModal, renderWealth, openSetModal, renderSet,
    renderNews, refreshNews, applyNewsOpt, genHeadlines, lotOf, unitOf, maxBuyable, renderSwan
  };
})();
