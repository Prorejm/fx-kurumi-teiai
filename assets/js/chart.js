/* ============================================================
   chart.js — 手写 Canvas 图表引擎 (无第三方依赖)
   日K / 周K / 分时 / 资产曲线
   ========================================================== */
window.ChartKit = (function () {
  'use strict';

  /* ------------------------------------------------------------
     帝爱版主题色（浅色专业）。全部走主题对象，方便运行时切换。
     涨红跌绿 —— 中国市场习惯。
     ---------------------------------------------------------- */
  const THEME = {
    up: '#c8382c', down: '#158a5b', flat: '#8b93a1',
    ink: '#2a3444', grid: '#e6e4dd', paper: '#ffffff',
    ma5: '#c9822a', ma10: '#2f6fb5', ma20: '#9257a8',
    cost: '#8a6bbf', base: '#b3ab9c',
    volUpA: 0.42, volDnA: 0.42,
    areaTop: 0.24
  };
  const DEFAULT_THEME = Object.assign({}, THEME);
  function setTheme(t) { Object.assign(THEME, DEFAULT_THEME, t || {}); }
  function theme() { return THEME; }

  /* 把 hex 转成 rgba()，用于量柱 / 面积渐变 */
  function rgba(hex, a) {
    const h = String(hex).replace('#', '');
    const n = h.length === 3
      ? h.split('').map(c => c + c).join('')
      : h;
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function prep(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '700 11px "DIN Alternate","Roboto Mono","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'middle';
    return { ctx, w, h };
  }

  function fmt(n, d) {
    n = +n;
    if (!isFinite(n)) return '--';
    return n.toFixed(d === undefined ? 2 : d);
  }
  function kvol(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }

  /* ================= 蜡烛图 ================= */
  /* bars: [{d,o,h,l,c,v,ma5,ma10,ma20}]   opts:{showMA, cross:{x,y}|null, limitLine} */
  function candles(cv, bars, opts) {
    const P = prep(cv); if (!P) return null;
    const { ctx, w, h } = P;
    opts = opts || {};

    if (!bars || !bars.length) {
      ctx.fillStyle = THEME.flat; ctx.textAlign = 'center';
      ctx.font = '700 14px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return null;
    }

    const padL = 8, padR = 62, padT = 10, padB = 20;
    const volH = Math.max(38, h * 0.19);
    const mainH = h - volH - padT - padB - 10;
    const cw = w - padL - padR;

    let lo = Infinity, hi = -Infinity, vMax = 0;
    for (const b of bars) {
      const mn = Math.min(b.l, b.o, b.c), mx = Math.max(b.h, b.o, b.c);
      if (opts.showMA) {
        if (b.ma5) { lo = Math.min(lo, b.ma5); hi = Math.max(hi, b.ma5); }
        if (b.ma10) { lo = Math.min(lo, b.ma10); hi = Math.max(hi, b.ma10); }
        if (b.ma20) { lo = Math.min(lo, b.ma20); hi = Math.max(hi, b.ma20); }
      }
      if (mn < lo) lo = mn; if (mx > hi) hi = mx;
      if (b.v > vMax) vMax = b.v;
    }
    const span = (hi - lo) || hi * 0.02 || 1;
    hi += span * 0.06; lo -= span * 0.06;
    const rng = hi - lo;

    const n = bars.length;
    const bw = Math.max(1.6, Math.min(16, cw / n * 0.68));
    const step = cw / n;
    const X = i => padL + i * step + step / 2;
    const Y = p => padT + (hi - p) / rng * mainH;
    const volTop = padT + mainH + 12;
    const VY = v => volTop + volH - (vMax ? v / vMax * volH : 0);

    /* 网格 + 价格标尺 (跳过与最新价标签重叠的一格) */
    const lastBar = bars[n - 1];
    const lastY = Y(lastBar.c);
    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
    ctx.fillStyle = THEME.ink; ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const p = hi - rng * i / 4, y = Y(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
      if (Math.abs(y - lastY) > 12) ctx.fillText(fmt(p), padL + cw + 6, y);
    }
    ctx.fillText(kvol(vMax), padL + cw + 6, volTop + 8);

    /* 日期轴 */
    ctx.textAlign = 'center'; ctx.fillStyle = THEME.base;
    const tickGap = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i++) {
      if (i % tickGap && i !== n - 1) continue;
      const d = (bars[i].d || '').slice(2).replace(/-/g, '/');
      ctx.fillText(d, X(i), h - 9);
    }

    /* 蜡烛 */
    for (let i = 0; i < n; i++) {
      const b = bars[i], x = X(i);
      const up = b.c >= b.o;
      const col = up ? THEME.up : THEME.down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
      const yo = Y(b.o), yc = Y(b.c);
      const top = Math.min(yo, yc), hh = Math.max(1.2, Math.abs(yc - yo));
      ctx.fillRect(x - bw / 2, top, bw, hh);
    }

    /* 均线 */
    if (opts.showMA) {
      for (const key of ['ma5', 'ma10', 'ma20']) {
        ctx.strokeStyle = THEME[key]; ctx.lineWidth = 1.7;
        ctx.beginPath(); let started = false;
        for (let i = 0; i < n; i++) {
          const v = bars[i][key];
          if (!isFinite(v) || v === null) continue;
          const x = X(i), y = Y(v);
          started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
        }
        ctx.stroke();
      }
      /* 图例 */
      ctx.textAlign = 'left'; let lx = padL + 2;
      for (const key of ['ma5', 'ma10', 'ma20']) {
        ctx.fillStyle = THEME[key];
        ctx.fillText(key.toUpperCase().replace('MA', 'MA'), lx, padT + 6);
        lx += 40;
      }
    }

    /* 成交量 */
    for (let i = 0; i < n; i++) {
      const b = bars[i], x = X(i);
      ctx.fillStyle = b.c >= b.o ? rgba(THEME.up, THEME.volUpA) : rgba(THEME.down, THEME.volDnA);
      const y = VY(b.v);
      ctx.fillRect(x - bw / 2, y, bw, volTop + volH - y);
    }

    /* 最新价水平线 */
    const last = bars[n - 1];
    if (last) {
      const y = Y(last.c);
      ctx.save();
      ctx.setLineDash([4, 3]); ctx.strokeStyle = last.c >= last.o ? THEME.up : THEME.down; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = last.c >= last.o ? THEME.up : THEME.down; ctx.textAlign = 'left';
      ctx.fillRect(padL + cw + 3, y - 8, 55, 16);
      ctx.fillStyle = THEME.paper;
      ctx.fillText(fmt(last.c), padL + cw + 6, y);
    }

    /* 成本线 */
    if (opts.costLine) {
      const y = Y(opts.costLine);
      if (y > padT && y < padT + mainH) {
        ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = THEME.cost; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = THEME.cost; ctx.textAlign = 'right';
        ctx.fillText('成本 ' + fmt(opts.costLine), padL + cw - 4, y - 9);
      }
    }

    /* 十字光标 */
    if (opts.cross) {
      const ci = opts.cross.index;
      const b = bars[ci]; if (!b) return { X, Y, step, padL, bw };
      const x = X(ci);
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(THEME.ink, .55); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, volTop + volH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, Y(b.c)); ctx.lineTo(padL + cw, Y(b.c)); ctx.stroke();
      ctx.restore();
    }
    return { X, Y, step, padL, bw, volTop, volH };
  }

  /* ================= 分时图 ================= */
  function minute(cv, arr, prevClose, flatNote) {
    const P = prep(cv); if (!P) return;
    const { ctx, w, h } = P;
    if (!arr || arr.length < 2) {
      ctx.fillStyle = THEME.flat; ctx.textAlign = 'center';
      ctx.font = '700 13px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(flatNote || '分时数据需联网获取', w / 2, h / 2);
      return;
    }
    const padL = 8, padR = 62, padT = 12, padB = 20;
    const volH = Math.max(30, h * 0.16);
    const mainH = h - volH - padT - padB - 10;
    const cw = w - padL - padR;

    let lo = Infinity, hi = -Infinity, vMax = 0, sumV = 0, sumPV = 0;
    for (const p of arr) {
      if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p;
      if (p.v > vMax) vMax = p.v;
      sumV += p.v; sumPV += p.p * p.v;
    }
    const base = prevClose || arr[0].p;
    const dev = Math.max(Math.abs(hi - base), Math.abs(base - lo), 0.0001);
    const mid = base, rng = dev * 2.25;
    const X = i => padL + i / (arr.length - 1) * cw;
    const Y = p => padT + (mid + rng / 2 - p) / rng * mainH;
    const avg = sumV ? sumPV / sumV : base;
    const volTop = padT + mainH + 12;
    const VY = v => volTop + volH - (vMax ? v / vMax * volH : 0);

    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.ink; ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const p = mid + rng / 2 - rng * i / 4, y = Y(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
      const pct = ((p - base) / base * 100).toFixed(2);
      ctx.fillStyle = p >= base ? THEME.up : THEME.down;
      ctx.fillText(fmt(p), padL + cw + 6, y - 5);
      ctx.fillText(pct + '%', padL + cw + 6, y + 7);
    }
    /* 基准线 */
    ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = THEME.base; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(padL, Y(base)); ctx.lineTo(padL + cw, Y(base)); ctx.stroke();
    ctx.restore();

    const lastP = arr[arr.length - 1].p;
    const col = lastP >= base ? THEME.up : THEME.down;

    /* 面积 */
    ctx.beginPath();
    ctx.moveTo(X(0), Y(base));
    for (let i = 0; i < arr.length; i++) ctx.lineTo(X(i), Y(arr[i].p));
    ctx.lineTo(X(arr.length - 1), Y(base));
    ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + mainH);
    g.addColorStop(0, rgba(lastP >= base ? THEME.up : THEME.down, THEME.areaTop));
    g.addColorStop(1, rgba(THEME.paper, 0));
    ctx.fillStyle = g; ctx.fill();

    /* 均线 */
    ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = THEME.ma5; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, Y(avg)); ctx.lineTo(padL + cw, Y(avg)); ctx.stroke();
    ctx.restore();

    /* 价格线 */
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = X(i), y = Y(arr[i].p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();

    /* 量柱 */
    for (let i = 0; i < arr.length; i++) {
      const bw = Math.max(1, cw / arr.length - 0.6);
      ctx.fillStyle = arr[i].p >= (i ? arr[i - 1].p : base) ? rgba(THEME.up, THEME.volUpA) : rgba(THEME.down, THEME.volDnA);
      const y = VY(arr[i].v);
      ctx.fillRect(X(i) - bw / 2, y, bw, volTop + volH - y);
    }
    ctx.fillStyle = THEME.ink; ctx.textAlign = 'left';
    ctx.fillText('均价 ' + fmt(avg), padL + 4, padT + 6);
    ctx.textAlign = 'center'; ctx.fillStyle = THEME.base;
    ['09:30', '10:30', '11:30/13:00', '14:00', '15:00'].forEach((t, i) => {
      ctx.fillText(t, padL + cw * i / 4, h - 9);
    });
  }

  /* ================= 资产曲线 ================= */
  function equity(cv, series, benchSeries, labels) {
    const P = prep(cv); if (!P) return;
    const { ctx, w, h } = P;
    const padL = 8, padR = 8, padT = 12, padB = 18;
    const cw = w - padL - padR, ch = h - padT - padB;
    if (!series || series.length < 2) {
      ctx.fillStyle = THEME.flat; ctx.textAlign = 'center';
      ctx.font = '700 13px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('交易若干天后生成战绩曲线', w / 2, h / 2);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of series) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (benchSeries) for (const v of benchSeries) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const rng = (hi - lo) || Math.abs(hi) * 0.1 || 1;
    hi += rng * .08; lo -= rng * .08;
    const X = i => padL + i / (series.length - 1) * cw;
    const Y = v => padT + (hi - v) / (hi - lo) * ch;

    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + ch * i / 3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }
    /* 基准虚线 */
    if (benchSeries && benchSeries.length === series.length) {
      ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = THEME.base; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < benchSeries.length; i++) {
        const x = X(i), y = Y(benchSeries[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    }
    /* 净值曲线 */
    const last = series[series.length - 1], first = series[0];
    const col = last >= first ? THEME.up : THEME.down;
    ctx.beginPath(); ctx.moveTo(X(0), Y(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(X(i), Y(series[i]));
    ctx.lineTo(X(series.length - 1), padT + ch); ctx.lineTo(X(0), padT + ch); ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + ch);
    g.addColorStop(0, rgba(last >= first ? THEME.up : THEME.down, THEME.areaTop));
    g.addColorStop(1, rgba(THEME.paper, 0));
    ctx.fillStyle = g; ctx.fill();

    ctx.strokeStyle = col; ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = X(i), y = Y(series[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(X(series.length - 1), Y(last), 3.6, 0, 7); ctx.fill();

    ctx.fillStyle = THEME.ink; ctx.textAlign = 'left'; ctx.font = '700 10px "PingFang SC",sans-serif';
    ctx.fillText('¥' + Math.round(last).toLocaleString(), padL + 3, padT + 6);
    ctx.fillStyle = THEME.base; ctx.textAlign = 'right';
    ctx.fillText('灰虚线 = 沪深300 基准', w - padR - 3, padT + 6);
  }

  return {
    candles, minute, equity, prep, fmt, kvol, setTheme, theme, rgba,
    COLORS: THEME
  };
})();
