/* ============================================================
   main.js — 启动 / 模式配置 / 实时轮询
   ========================================================== */
(function () {
  'use strict';

  const LEV = [1, 2, 3, 5, 10, 25, 50];
  const PICK = { mode: 'replay', lev: 0, t0: false };

  const boot = document.getElementById('boot');
  const bootBar = document.getElementById('bootBar');
  const intro = document.getElementById('intro');
  const app = document.getElementById('app');

  function progress(p, txt) {
    if (bootBar) bootBar.style.width = p + '%';
    const s = document.querySelector('.boot-sub');
    if (s) s.textContent = txt;
  }

  function fail(msg) {
    boot.innerHTML = '<div class="boot-inner"><div class="boot-title">出错了</div>' +
      '<div class="boot-sub">' + msg + '</div></div>';
  }

  /* ---------- 开场弹窗 ---------- */
  function setupIntro() {
    const av = document.getElementById('introAvatar');
    const lineEl = document.getElementById('introLine');
    av.innerHTML = Char.face('greeting', { anim: 'av-pop' });
    lineEl.innerHTML = Char.line('greeting');

    const levSlider = document.getElementById('introLev');
    const levVal = document.getElementById('introLevVal');
    const t0Wrap = document.getElementById('t0Wrap');
    const t0Check = document.getElementById('t0Check');

    document.querySelectorAll('.mode-card').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.mode-card').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        PICK.mode = c.dataset.mode;
        t0Wrap.classList.toggle('hidden', PICK.mode !== 'live');
        av.innerHTML = Char.face(PICK.mode === 'live' ? 'wide' : 'greeting', { anim: 'av-pop' });
        lineEl.innerHTML = PICK.mode === 'live'
          ? '实盘同步。<b>当下的价格</b>就是真的在跳，不会等你。'
          : '历史回放。随机接入某个真实交易日，之后每一步都由您自己承担。';
      });
    });
    document.querySelector('.mode-card').click();

    const syncLev = (el, out) => {
      const v = LEV[+el.value];
      out.textContent = v + 'x';
      return v;
    };
    levSlider.addEventListener('input', () => {
      const v = syncLev(levSlider, levVal);
      av.innerHTML = Char.face(v >= 5 ? 'eager' : (v > 1 ? 'think' : 'idle'),
        { anim: v >= 10 ? 'av-shake' : 'av-pop' });
      lineEl.innerHTML = v >= 25 ? '<b>FX 模式。</b>最大额度。一次反向就足以清空账户。'
        : v >= 10 ? '十倍。额度充足，风险同步放大。'
          : v >= 5 ? '五倍。属于常见区间。'
            : v > 1 ? '两到三倍。可以接受。'
              : '现货结算，不设强平。这也是一种选择。';
    });
    t0Check.addEventListener('change', () => { PICK.t0 = t0Check.checked; });

    document.getElementById('startBtn').onclick = () => {
      PICK.lev = LEV[+levSlider.value];
      PICK.t0 = t0Check.checked && PICK.mode === 'live';
      start(null);
    };
    document.getElementById('continueBtn').onclick = () => {
      const sv = Game.loadSave();
      if (!sv) { UI.toast('没有找到存档', 'warn'); return; }
      start(sv);
    };
    if (!Game.hasSave()) document.getElementById('continueBtn').classList.add('hidden');
  }

  /* ---------- 启动游戏 ---------- */
  function start(save) {
    intro.classList.add('hidden');
    app.classList.remove('hidden');

    if (save) {
      Game.restore(save);
      Market.S.mode = Game.G.mode;
    } else {
      const idx = PICK.mode === 'live' ? Market.dates.length - 1 : Market.randomStart(90);
      Game.reset(PICK.mode, PICK.lev, idx, { t0: PICK.t0 });
    }
    Game.checkBadges();

    UI.bind();
    const first = Game.G.positions.length ? Game.G.positions[0].code : 'sh600519';
    UI.S.code = first;
    UI.buildWatch();
    UI.select(first);
    UI.fillPrice();
    UI.refreshAll();
    UI.tempFace(save ? 'idle' : 'greeting',
      save ? '存档已调取。继续上次的持仓。' : '账户已开立。初始额度已入账，请查看行情列表。', 3200, 'av-pop');

    wireEvents();
    if (Game.G.mode === 'live') startLive();
    requestAnimationFrame(() => { UI.drawChart(); UI.drawEquity(); });
  }

  /* ---------- 游戏事件 → 表演 ---------- */
  function wireEvents() {
    Game.on((ev, d) => {
      if (ev === 'change') return;
      if (ev === 'marginCall') {
        UI.tempFace('panic', '追保通知：<b>维持担保比例 ' + d.mr.toFixed(0) + '%</b>，请立即补足担保物。', 3400, 'av-shake');
        UI.toast('⚠ 追加保证金：维持担保比例 ' + d.mr.toFixed(1) + '%', 'warn');
      }
      if (ev === 'losscut') {
        const loss = (d.closed || []).reduce((s, o) => s + o.pnl, 0);
        UI.showFx('blowup', '强制平仓',
          `维持担保比例跌破 100%，系统已执行<b>强制平仓</b>。<br>
           本次强平损益 <b style="color:${loss >= 0 ? '#c8382c' : '#158a5b'}">${UI.money(loss)}</b> 元<br>
           <span>剩余负债仍由您承担。请留意下一份追保通知。</span>`, '重 新 开 立');
      }
      if (ev === 'ruin') {
        if (!Game.G._recorded) { Game.G._recorded = true; Game.recordRun('你'); }
        UI.showFx('dead', '清 算',
          d.viaIll
            ? `非法债务已完全覆盖您的偿付能力。<br>这就是“以贷养贷”的终点。<br>
               <span>现实中，请务必远离高利贷、套路贷、网贷陷阱。</span>`
            : `本金归零，账户已进入清算程序。<br>
               <span>最终成就：中毒度 ${Math.round(Game.G.addic)}%</span>`, '重 新 开 立');
      }
      if (ev === 'illBorrow') {
        UI.tempFace('worry', '已为您放款。请留意年化利率与还款日——复利的增长速度通常超出预期。', 3400, 'av-shake');
        UI.toast('⚠ 已借入非正规借贷，利息按日滚动', 'bad');
      }
      if (ev === 'collect') {
        const msgs = {
          1: '催收阶段一：短信提醒已发送',
          2: '催收阶段二：已通知您的紧急联系人',
          3: '催收阶段三：上门核实并处置抵押物'
        };
        UI.toast(msgs[d.stage] || '催收升级', 'bad');
        if (d.stage >= 2) UI.tempFace('panic', '催收已联系到您的亲友。这就是网贷的真实成本。', 3800, 'av-shake');
      }
      if (ev === 'civBorrow') {
        UI.toast('已借入「' + d.product.name + '」，请留意还款日', 'warn');
      }
      if (ev === 'civOverdue') {
        if (d.kind === 'friend') {
          UI.tempFace('sad', '亲友借款已逾期。钱可以慢慢还，关系不容易。', 3400, 'av-shake');
          UI.toast('⚠ 亲友借款逾期，人情受损', 'bad');
        } else {
          UI.tempFace('panic', '消费信贷已逾期，本次记录将上报征信。', 3600, 'av-shake');
          UI.toast('⚠ 消费信贷逾期，征信受损', 'bad');
        }
      }
      if (ev === 'badge') UI.toast('解锁成就：' + d.name, 'ok');
      if (ev === 'limitUp') {
        const m = Market.meta.find(x => x.code === d.code);
        UI.toast('涨停：' + (m ? m.name : '') , 'ok');
      }
      if (ev === 'limitDown') {
        const m = Market.meta.find(x => x.code === d.code);
        UI.toast('跌停：' + (m ? m.name : '') + ' — 卖盘挂不出去', 'bad');
      }
      if (ev === 'leverUp') {
        UI.tempFace('eager', '杠杆已上调至 <b>' + d.v + 'x</b>。保证金要求同步下降。', 2800, 'av-pop');
      }
      /* ---- 理财类 ---- */
      if (ev === 'repoBuy') {
        UI.tempFace('idle', '已出借 ' + UI.money(d.amount) + ' 元，' + d.days + ' 个交易日后到期回款。', 2600);
      }
      if (ev === 'repoMature') {
        UI.toast('逆回购到期回款，利息 +' + UI.num(d.interest) + ' 元', 'ok');
      }
      if (ev === 'wealthBuy') {
        UI.toast('已申购理财 ' + UI.money(d.amount) + ' · 净值型产品，不保本', 'warn');
      }
      if (ev === 'wealthRedeem') {
        UI.toast((d.pnl >= 0 ? '赎回盈利 +' : '赎回亏损 ') + UI.money(Math.abs(d.pnl)), d.pnl >= 0 ? 'ok' : 'bad');
      }
      if (ev === 'dcaSet') UI.toast('已设置定投：每 ' + d.every + ' 个交易日 ' + UI.money(d.amount) + ' 元', 'ok');
      if (ev === 'insureBuy') UI.tempFace('think', '保险姓保。先转移风险，再谈收益。', 3000);
      if (ev === 'insureSurrender') {
        UI.toast('已退保，损失 ' + UI.money(d.loss), 'warn');
        UI.tempFace('sad', '退保损失即为流动性的价格。', 3000);
      }
      if (ev === 'pensionPay') {
        UI.toast('养老金缴费 ' + UI.money(d.amount) + ' · 个税抵扣 +' + UI.money(d.saved), 'ok');
      }
      if (ev === 'pensionOut') {
        UI.toast('已提前支取养老金，退回税优 ' + UI.money(d.claw), 'warn');
      }
      /* ---- 可转债打新 ---- */
      if (ev === 'cbApply') UI.toast('已信用申购 ' + d.lots + ' 手，等待中签结果', 'ok');
      if (ev === 'cbIpo') {
        const up = d.ret >= 0;
        UI.tempFace(up ? 'happy' : 'sad', up
          ? '中签入账。首日 <b>+' + (d.ret * 100).toFixed(1) + '%</b>，零成本申购已结算。'
          : '中签即破发。首日 <b>' + (d.ret * 100).toFixed(1) + '%</b>——打新并非无风险。',
          3400, up ? 'av-pop' : 'av-shake');
        UI.toast((up ? '中签盈利 +' : '中签亏损 ') + UI.money(Math.abs(d.pnl)), up ? 'ok' : 'bad');
      }
      if (ev === 'cbForfeit') {
        UI.tempFace('worry', '中签未缴款，本次计入弃购记录。', 3400, 'av-shake');
        UI.toast('⚠ 弃购第 ' + d.count + ' 次（满 ' + Game.CB_FORFEIT_MAX + ' 次将禁购 6 个月）', 'bad');
      }
      /* ---- 分红 ---- */
      if (ev === 'dividend') {
        const m = Market.metaOf(d.code);
        UI.toast((m ? m.name : '') + ' 派发现金红利 +' + UI.money(d.cash) + '（除息日市值同步下调）', 'ok');
      }
      /* ---- 黑天鹅 ---- */
      if (ev === 'swan') {
        const bull = d.kind === 'bull';
        UI.tempFace(d.face || (bull ? 'wide' : 'panic'),
          bull ? '<b>' + d.name + '</b>。政策面出现变化，请注意仓位方向。'
               : '<b>' + d.name + '</b>。该情形未包含在历史样本中，波动将重新定价。',
          5000, bull ? 'av-pop' : 'av-shake');
        UI.toast((bull ? '利好冲击：' : '黑天鹅：') + d.name + ' · ' + d.days + ' 个交易日内生效', bull ? 'ok' : 'bad');
      }
      /* ---- 反身性 ---- */
      if (ev === 'butterfly') {
        UI.tempFace('worry', '市场的定价开始对您的行为作出反应。这只票已偏离原历史路径。', 4200, 'av-shake');
      }
      if (ev === 'shockBuy') {
        UI.toast('⚠ 委托量偏大，冲击成本 ' + (d.slip * 100).toFixed(2) + '%', 'warn');
      }
    });
    document.getElementById('fxBtn').onclick = () => location.reload();

    /* 杠杆弹窗 */
    const lvModal = document.getElementById('levModal');
    const lvSlider = document.getElementById('levSlider');
    const lvVal = document.getElementById('levVal');
    /* 打开杠杆弹窗时同步当前值 (按钮绑定在 UI.bind) */
    window.__openLevModal = () => {
      lvSlider.value = Math.max(0, LEV.indexOf(Game.G.leverage));
      lvVal.textContent = Game.G.leverage + 'x';
      lvModal.classList.remove('hidden');
    };
    lvSlider.addEventListener('input', () => { lvVal.textContent = LEV[+lvSlider.value] + 'x'; });
    document.getElementById('levOk').onclick = () => {
      const v = LEV[+lvSlider.value];
      if (v !== Game.G.leverage) {
        Game.setLeverage(v);
        UI.toast('杠杆已调整为 ' + v + 'x' + (v > 1 ? ' · 退場风险上升' : ' · 安全模式'), v > 1 ? 'warn' : 'ok');
      }
      lvModal.classList.add('hidden');
      UI.refreshAll();
    };
    lvModal.addEventListener('click', e => { if (e.target === lvModal) lvModal.classList.add('hidden'); });
  }

  /* ---------- 实时模式轮询 ---------- */
  function startLive() {
    const codes = Market.tradable.map(m => m.code);
    const tick = () => {
      Market.fetchQuotes(codes).then(n => {
        if (n > 0) {
          UI.el.liveDot.classList.remove('hidden');
          UI.updateWatch(); UI.renderPos(); UI.renderTop();
          UI.renderHud(); UI.renderFoot(); UI.drawChart();
          UI.refreshFace();
          /* 当前股票分时每轮更新一次 */
          if (UI.S.code) Market.fetchIntraday(UI.S.code).then(() => {
            if (UI.S.view === 'minute') UI.drawChart();
          });
        }
      });
    };
    tick();
    setInterval(tick, 15000);
    /* RSS 快讯: 启动时刷新一次, 之后每 5 分钟尝试一次 (失败静默回退内置快讯) */
    const newsTick = () => Market.fetchNews(true).then(n => {
      if (n > 0) { UI.refreshNews(); }
    }).catch(() => { });
    newsTick();
    setInterval(newsTick, 300000);
  }

  /* ---------- 入口 ---------- */
  function boot$() {
    progress(30, '正在载入真实行情数据…');
    setTimeout(() => {
      if (!window.SNAPSHOT || !window.SNAPSHOT.d || !window.SNAPSHOT.d.length) {
        fail('行情数据包加载失败，请确认 data/snapshot.js 存在。');
        return;
      }
      try {
        const n = Market.init(window.SNAPSHOT);
        progress(80, '载入 ' + n + ' 个标的…');
        setupIntro();
        progress(100, '就绪');
        setTimeout(() => {
          boot.classList.add('hidden');
          intro.classList.remove('hidden');
        }, 220);
      } catch (e) {
        fail('初始化失败：' + e.message);
        console.error(e);
      }
    }, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot$);
  else boot$();
})();
