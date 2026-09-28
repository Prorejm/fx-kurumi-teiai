/* ============================================================
   market.js — 行情引擎
   离线: data/snapshot.js 内置真实历史
   在线: 腾讯财经 qt.gtimg.cn (实时) / ifzq.gtimg.cn (分时·日线)
   均为跨域开放接口, 无需 Key
   注: web.ifzq.gtimg.cn 已被腾讯 WAF 拦截(501), 故统一改用 ifzq.gtimg.cn
   ========================================================== */
window.Market = (function () {
  'use strict';

  const RT_URL = 'https://qt.gtimg.cn/q=';
  const MIN_URL = 'https://ifzq.gtimg.cn/appstock/app/minute/query?code=';
  const DAY_URL = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=';

  const S = {
    meta: [], dates: [], series: {}, bench: 'sh000300',
    idx: 0, mode: 'replay',
    quotes: {},        // code -> 实时快照
    intraday: {},      // code -> [{t,p,v}]
    startIdx: 0,
    online: false, lastTickAt: 0,
    scale: {},         // code -> 价格缩放 (100 股价 / 10000 汇率·净值)
    byCode: {},        // code -> meta  (O(1) 查询)
    cbSet: {},         // 可转债集合
    listIdx: {},       // 可转债首个有效交易日下标
    divcal: [],        // 除权日历 [{c,d,s}]
    divByDate: {},     // 日期 -> 除权事件数组
    news: [],          // RSS 财经快讯 [{t,src,d,u}]
    newsFetchedAt: 0   // 最近一次在线抓取时间戳
  };

  function dec(buf) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { /* fall */ }
    try { return new TextDecoder('gb18030').decode(buf); } catch (e) { /* fall */ }
    return new TextDecoder('utf-8').decode(buf);
  }

  function get(url, asBuf) {
    return fetch(url, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asBuf ? r.arrayBuffer() : r.text();
    });
  }

  /* ---------- 初始化 ---------- */
  function init(snap) {
    const ZONE = {
      main: 'A', gem: 'A', star: 'A', us: 'US', hk: 'HK', fx: 'FX',
      fd: 'FD', rp: 'RP', wm: 'WM', cb: 'CB'
    };
    S.meta = snap.m.map(a => ({
      code: a[0], name: a[1], ind: a[2],
      market: a[3], limitPct: a[4],
      /* rp(逆回购) / wm(银行理财) 不是「股票池里的可交易标的」——
         逆回购走理财中心的期限下单, 理财走净值申购, 都不进自选列表 */
      tradable: a[3] !== 'index' && a[3] !== 'rp' && a[3] !== 'wm',
      zone: a[3] === 'index' ? 'IDX' : (ZONE[a[3]] || 'A')
    })).filter(s => !S.seen_(s.code));
    S.dates = snap.d;
    S.series = snap.s;
    S.divcal = snap.dv || [];       // 除权日历 [{c,d,s}]
    S.news = snap.news || [];       // 内置 RSS 快讯 (构建期抓取)
    S.idx = snap.d.length - 1;
    S.startIdx = S.idx;
    buildIndex();
    return S.meta.length;
  }

  /* 首个非零 bar (可转债上市首日判定) */
  function firstLiveBar(code) {
    const arr = S.series[code];
    if (!arr) return -1;
    for (let i = 0; i < S.dates.length; i++) {
      const b = i * 5;
      if (b + 3 >= arr.length) break;
      if (arr[b + 3] > 0) return i;
    }
    return -1;
  }

  /* 建立 O(1) 索引: 缩放 / meta / 可转债集合 / 上市首日 */
  function buildIndex() {
    S.scale = {}; S.byCode = {}; S.cbSet = {}; S.listIdx = {};
    S.divByDate = {};
    for (const m of S.meta) {
      S.byCode[m.code] = m;
      S.scale[m.code] = (m.market === 'fx' || m.market === 'wm') ? 10000 : 100;
      if (m.market === 'cb') {
        S.cbSet[m.code] = 1;
        S.listIdx[m.code] = firstLiveBar(m.code);
      }
    }
    for (const e of S.divcal) {
      (S.divByDate[e.d] || (S.divByDate[e.d] = [])).push(e);
    }
  }

  const seen = {};
  S.seen_ = function (c) { if (seen[c]) return true; seen[c] = 1; return false; };

  /* ---------- 基础取数 ---------- */
  function raw(code, i) {
    const arr = S.series[code];
    if (!arr) return null;
    const b = i * 5;
    if (b + 4 >= arr.length) return null;
    const sc = S.scale[code] || 100;
    return {
      d: S.dates[i], o: arr[b] / sc, h: arr[b + 1] / sc,
      l: arr[b + 2] / sc, c: arr[b + 3] / sc, v: arr[b + 4]
    };
  }

  /* 当前 bar (实时覆盖最后一根) */
  function bar(code, i) {
    i = (i === undefined) ? S.idx : i;
    const b = raw(code, i);
    if (!b) return null;
    if (i === S.idx) {
      const q = S.quotes[code];
      if (q && S.mode === 'live' && q.p > 0) {
        return {
          d: b.d, o: q.o > 0 ? q.o : b.o, h: Math.max(q.h, q.p),
          l: q.l > 0 ? Math.min(q.l, q.p) : Math.min(b.l, q.p),
          c: q.p, v: q.v > 0 ? q.v : b.v,
          _rt: true
        };
      }
    }
    return b;
  }

  function prevClose(code, i) {
    i = (i === undefined) ? S.idx : i;
    const p = raw(code, i - 1);
    if (p) return p.c;
    return bar(code, i) ? bar(code, i).o : 0;
  }

  function price(code) {
    const b = bar(code);
    return b ? b.c : 0;
  }

  function chg(code) {
    const b = bar(code); if (!b) return { abs: 0, pct: 0 };
    const pc = prevClose(code) || b.o;
    return { abs: b.c - pc, pct: pc ? (b.c - pc) / pc * 100 : 0 };
  }

  /* ---------- 序列 + 均线 ---------- */
  function series(code, count, end) {
    end = end === undefined ? S.idx : Math.min(end, S.idx);
    count = count || 120;
    const start = Math.max(0, end - count + 1);
    const out = [];
    // 多取 20 根用于计算 MA
    const pad = Math.max(0, start - 20);
    const tmp = [];
    for (let i = pad; i <= end; i++) {
      const b = raw(code, i);
      if (b) tmp.push(b);
    }
    for (let i = 0; i < tmp.length; i++) {
      const b = Object.assign({}, tmp[i]);
      const ma = (n) => {
        if (i < n - 1) return null;
        let s = 0;
        for (let k = 0; k < n; k++) s += tmp[i - k].c;
        return s / n;
      };
      b.ma5 = ma(5); b.ma10 = ma(10); b.ma20 = ma(20);
      out.push(b);
    }
    return out.slice(-(end - Math.max(start, pad) + 1));
  }

  /* 近期成交量的中位数 —— 用于估算流动性 / 冲击成本
     注: 同一标的序列来自同一数据源, 故成交量单位自洽 */
  function avgVol(code, n) {
    n = n || 60;
    const end = S.idx, start = Math.max(0, end - n + 1);
    const vals = [];
    for (let i = start; i <= end; i++) {
      const b = raw(code, i);
      if (b && b.v > 0 && isFinite(b.v)) vals.push(b.v);
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  /* 周/月 K 聚合 */
  function agg(code, unit, count, end) {    end = end === undefined ? S.idx : end;
    const d = series(code, unit === 'week' ? (count + 1) * 5 : (count + 1) * 20, end);
    const out = [];
    let cur = null, curKey = '';
    for (const b of d) {
      const dt = new Date(b.d + 'T00:00:00');
      let key;
      if (unit === 'week') {
        const dow = (dt.getDay() + 6) % 7;
        const monday = new Date(dt); monday.setDate(dt.getDate() - dow);
        key = monday.toISOString().slice(0, 10);
      } else key = b.d.slice(0, 7);
      if (key !== curKey) {
        if (cur) out.push(cur);
        cur = { d: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        curKey = key;
      } else {
        cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
        cur.c = b.c; cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out.slice(-count);
  }

  /* ---------- 时间推进 ---------- */
  function next(n) {
    n = n || 1;
    const old = S.idx;
    S.idx = Math.min(S.dates.length - 1, S.idx + n);
    return S.idx - old;
  }
  function canNext() { return S.idx < S.dates.length - 1; }
  function date(i) { return S.dates[i === undefined ? S.idx : i] || ''; }

  function randomStart(minAhead) {
    minAhead = minAhead || 90;
    const max = S.dates.length - 1 - minAhead;
    const min = 30;
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min));
  }

  function setIdx(i) { S.idx = Math.max(0, Math.min(S.dates.length - 1, i | 0)); }

  /* ---------- 在线: 实时报价 ---------- */
  function chunk(a, n) {
    const r = [];
    for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n));
    return r;
  }

  function fetchQuotes(codes) {
    if (!codes || !codes.length) return Promise.resolve(0);
    const jobs = chunk(codes, 40).map(part =>
      get(RT_URL + part.join(','), true).then(buf => {
        const txt = dec(buf);
        let n = 0;
        txt.split(';').forEach(line => {
          const m = line.match(/v_([a-zA-Z0-9]+)="([^"]*)"/);
          if (!m) return;
          const f = m[2].split('~');
          if (f.length < 40) return;
          const code = m[1];
          const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
          const q = {
            name: f[1], p: num(f[3]), pc: num(f[4]), o: num(f[5]),
            v: num(f[6]) * 100, amount: num(f[37]) * 10000,
            time: f[30], chg: num(f[31]), chgPct: num(f[32]),
            h: num(f[33]), l: num(f[34]), turn: num(f[38]),
            pe: num(f[39]), amp: num(f[43]), fcap: num(f[44]), cap: num(f[45]),
            pb: num(f[46]), limitUp: num(f[47]), limitDown: num(f[48]), at: Date.now()
          };
          if (q.p > 0) { S.quotes[code] = q; n++; }
        });
        return n;
      }).catch(() => 0)
    );
    return Promise.all(jobs).then(rs => {
      const t = rs.reduce((a, b) => a + b, 0);
      if (t > 0) { S.online = true; S.lastTickAt = Date.now(); }
      return t;
    });
  }

  /* ---------- 在线: 当日分时 ---------- */
  function fetchIntraday(code) {
    return get(MIN_URL + code).then(txt => {
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[code];
      const rows = node && node.data && node.data.data;
      if (!rows || !rows.length) return null;
      let acc = 0;
      const out = rows.map(r => {
        const p = r.trim().split(/\s+/);
        const v = parseFloat(p[2]) || 0;
        const delta = v - acc; acc = v;
        return { t: p[0], p: parseFloat(p[1]), v: Math.max(0, delta) };
      }).filter(x => isFinite(x.p));
      if (out.length) { S.intraday[code] = out; S.online = true; }
      return out;
    }).catch(() => null);
  }

  /* ---------- 在线: RSS 财经快讯 (CORS 中继, 失败则回退内置快照) ---------- */
  const NEWS_FEEDS = [
    { src: '东方财富', url: 'https://rss.eastmoney.com/rss_partener.xml' },
    { src: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664' }
  ];
  /* 公共 CORS 中继 (纯前端静态站点无后端时的通用做法), 任一可用即可 */
  const RELAYS = [
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    u => 'https://corsproxy.io/?' + encodeURIComponent(u)
  ];

  function parseFeed(txt, src, cap) {
    const items = [];
    const blockRe = /<(item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi;
    const blocks = txt.match(blockRe) || [];
    blocks.forEach(b => {
      const pick = tag => {
        const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
        if (!m) return '';
        return m[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ').trim();
      };
      const t = pick('title');
      if (!t) return;
      let u = pick('link');
      if (!u) {
        const lm = b.match(/<link[^>]*href="([^"]+)"/i);
        u = lm ? lm[1] : '';
      }
      items.push({ t, src, d: pick('pubDate') || pick('updated'), u });
    });
    return items.slice(0, cap);
  }

  let newsTried = false;
  function fetchNews(force) {
    if (newsTried && !force) return Promise.resolve(S.news.length);
    newsTried = true;
    const jobs = [];
    NEWS_FEEDS.forEach(f => {
      RELAYS.forEach(mk => {
        jobs.push(
          get(mk(f.url)).then(txt => parseFeed(txt.replace(/^\uFEFF/, ''), f.src, 60))
            .catch(() => [])
        );
      });
    });
    return Promise.all(jobs).then(rs => {
      /* 按来源去重, 保留条目最多的那份中继结果 */
      const best = {};
      rs.forEach(items => {
        if (!items.length) return;
        const src = items[0].src;
        if (!best[src] || items.length > best[src].length) best[src] = items;
      });
      const merged = [];
      Object.keys(best).forEach(k => merged.push.apply(merged, best[k]));
      if (merged.length >= 5) {
        S.news = merged;
        S.newsFetchedAt = Date.now();
      }
      return S.news.length;
    });
  }

  /* ---------- 离线: 由 OHLC 还原当日分时走势 ---------- */
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }
  function restored(code, i) {
    i = i === undefined ? S.idx : i;
    const b = raw(code, i);
    if (!b) return null;
    const pc = prevClose(code, i) || b.o;
    const rnd = hashSeed(code + b.d);
    const N = 48;
    const pts = [];
    /* 决定 high/low 出现顺序: 收盘强则先压后拉 */
    const upDay = b.c >= b.o;
    const iLow = 10 + Math.floor(rnd * 16);
    const iHigh = 26 + Math.floor((1 - rnd) * 14);
    const path = [];
    for (let k = 0; k <= N; k++) path.push(0);
    const setPeak = (idx, val) => {
      idx = Math.max(1, Math.min(N - 1, idx));
      for (let k = 0; k <= N; k++) {
        const w = Math.max(0, 1 - Math.abs(k - idx) / 9);
        path[k] += (val - (b.o * .5 + b.c * .5)) * w * w;
      }
    };
    setPeak(iLow, b.l); setPeak(iHigh, b.h);
    if (!upDay) { /* 高开低走则把高点前移 */ }
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      let p = b.o + (b.c - b.o) * t;
      p += path[k] * 0.85;
      p *= 1 + Math.sin(k * 1.7 + rnd * 6) * 0.0016;
      p = Math.max(b.l, Math.min(b.h, p));
      const base = Math.max(1, Math.abs(b.v) / N);
      pts.push({ t: '--', p: p, v: Math.round(base * (0.5 + Math.abs(Math.sin(k * 2.3 + rnd * 9)) * 1.2)) });
    }
    pts[0].p = b.o;
    pts[N].p = b.c;
    return { pts, prevClose: pc };
  }

  /* ---------- 在线: 补齐最新日线 ---------- */
  function fetchDaily(code, n) {
    n = n || 30;
    return get(DAY_URL + code + ',day,,,' + n + ',').then(txt => {
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[code];
      const rows = node && (node.day || node.qfqday);
      if (!rows || !rows.length) return 0;
      const map = {};
      rows.forEach(r => { map[r[0]] = r; });
      const arr = S.series[code]; if (!arr) return 0;
      let added = 0;
      rows.forEach(r => {
        let i = S.dates.indexOf(r[0]);
        if (i < 0) i = S.dates.length;  // 新交易日 -> 追加
        // 逐日写入(只处理数据集尾部)
        if (i >= S.dates.length - 1 || true) {
          const b = i * 5;
          for (let k = arr.length; k <= b + 4; k++) arr[k] = 0;
          const sc = scaleOf(code);
          arr[b] = Math.round(parseFloat(r[1]) * sc);
          arr[b + 1] = Math.round(parseFloat(r[3]) * sc);
          arr[b + 2] = Math.round(parseFloat(r[4]) * sc);
          arr[b + 3] = Math.round(parseFloat(r[2]) * sc);
          arr[b + 4] = Math.round(parseFloat(r[5]));
        }
      });
      return ++added;
    }).catch(() => 0);
  }

  function benchLevel(i) {
    const b = raw(S.bench, i === undefined ? S.idx : i);
    return b ? b.c : 0;
  }

  /* ---------- 品类判定 / 元信息 ---------- */
  function metaOf(code) { return S.byCode[code] || null; }
  function isCB(code) { return !!S.cbSet[code]; }
  function isRepo(code) { const m = S.byCode[code]; return !!m && m.market === 'rp'; }
  function isWealth(code) { const m = S.byCode[code]; return !!m && m.market === 'wm'; }
  function scaleOf(code) { return S.scale[code] || 100; }
  function listIdx(code) {
    const v = S.listIdx[code];
    return v === undefined ? -1 : v;
  }
  /* 当日除权事件 */
  function dividendsOn(d) {
    return S.divByDate[d === undefined ? date() : d] || [];
  }
  /* 查询某标的在给定日期区间的除权事件 */
  function dividendsOf(code, fromIdx, toIdx) {
    const from = fromIdx === undefined ? 0 : fromIdx;
    const to = toIdx === undefined ? S.dates.length - 1 : toIdx;
    const out = [];
    for (let i = from; i <= to && i < S.dates.length; i++) {
      const hit = S.divByDate[S.dates[i]];
      if (!hit) continue;
      for (const e of hit) if (e.c === code) out.push({ idx: i, d: e.d, s: e.s });
    }
    return out;
  }

  return {
    S, init, raw, bar, prevClose, price, chg, series, agg,
    next, canNext, date, randomStart, setIdx,
    fetchQuotes, fetchIntraday, fetchDaily, restored, benchLevel, fetchNews,
    metaOf, isCB, isRepo, isWealth, scaleOf, listIdx, avgVol,
    dividendsOn, dividendsOf,
    get meta() { return S.meta; },
    get dates() { return S.dates; },
    get idx() { return S.idx; },
    get divcal() { return S.divcal; },
    get news() { return S.news; },
    get tradable() { return S.meta.filter(m => m.tradable); }
  };
})();
