/* ============================================================
   game.js — 模拟撮合 / 账户 / 杠杆与退場
   现货规则: T+1 / 涨跌停 / 佣金最低5元 / 卖出印花税 / 沪市过户费
   杠杆规则: 维持担保比例 < 100% 触发ロスカット(强制平仓)
   ========================================================== */
window.Game = (function () {
  'use strict';

  const BASE = 1000000;          // 初始本金
  const FEE_RATE = 0.00025;      // 佣金 万2.5
  const FEE_MIN = 5;
  const TAX_RATE = 0.0005;       // 印花税 千0.5 (卖出)
  const TRANSFER_RATE = 0.00001; // 过户费 十万分之一(沪市, 双边)
  const LOAN_LTV = 0.7;          // 质押率 70%
  const LOAN_RATE = 0.06;        // 质押贷款年化利率 6%
  const FUND_RATE = 0.02;        // 现金理财(货币基金)年化 2%
  const MORT_LTV = 0.6;          // 固定资产抵押率 60%
  const MORT_RATE = 0.04;        // 固定资产抵押年化 4%
  const CREDIT_START = 750;      // 初始信用分
  const CREDIT_BAD = 600;        // 失信阈值
  /* 帝爱版与韭留美版可能同域部署（GitHub Pages 子路径 /fx-kurumi/teiai/），
     存储键必须分开，否则两个模拟器会互相覆盖存档与排行榜。 */
  const SAVE_KEY = 'teiai_save_v1';
  const LB_KEY = 'teiai_lb_v1';

  /* ---------------- 国债逆回购 (报价单位 = 年化利率%) ---------------- */
  const REPO_MIN = 1000;         // 沪深统一 1000 元起, 1000 元整数倍
  const RP_FEE = { 1: 1e-5, 2: 2e-5, 3: 3e-5, 4: 4e-5, 7: 5e-5, 14: 1e-4, 28: 2e-4, 91: 3e-4, 182: 3e-4 };
  const RP_FEE_CAP = 30;         // 91/182 天 手续费 30 元封顶
  const RP_DAYS = {
    sh204001: 1, sh204002: 2, sh204003: 3, sh204004: 4, sh204007: 7,
    sh204014: 14, sh204028: 28, sh204091: 91, sh204182: 182,
    sz131810: 1, sz131811: 2, sz131800: 3, sz131809: 4, sz131801: 7,
    sz131802: 14, sz131803: 28, sz131805: 91, sz131806: 182
  };

  /* ---------------- 可转债 ---------------- */
  const CB_LOT = 10;             // 1 手 = 10 张 = 1000 元面额
  const CB_FV = 100;             // 面值 100 元/张
  const CB_FEE_RATE = 0.0002;    // 仅佣金, 免印花税/过户费
  const CB_FEE_MIN = 1;
  const CB_FIRST_UP = 57.3;      // 上市首日涨幅上限
  const CB_FIRST_DOWN = 43.3;    // 上市首日跌幅上限
  const CB_BAN_DAYS = 126;       // 弃购 3 次 -> 6 个月(约126交易日)不得申购
  const CB_FORFEIT_MAX = 3;

  /* ---------------- 银行理财 ---------------- */
  const WM_MIN = 1000;           // 起购金额
  const WM_LEVELS = {
    R1: { name: '谨慎型', risk: '低', cap: 1000000, desc: '现金管理类，主投货币市场工具。流动性最好、收益最低，但仍不保本。' },
    R2: { name: '稳健型', risk: '中低', cap: 500000, desc: '固定收益类，主投债券，净值有小幅波动。' },
    R3: { name: '平衡型', risk: '中', cap: 300000, desc: '固收+，债券为主，权益类资产不超过 30%，波动明显放大。' },
    R4: { name: '进取型', risk: '中高', cap: 300000, desc: '权益类为主，净值波动接近股票型基金。' },
    R5: { name: '激进型', risk: '高', cap: 200000, desc: '可投衍生品、私募等，净值波动最大，可能大幅亏损。' }
  };

  /* ---------------- 商业保险 (简化 2 款) ---------------- */
  const INSURANCE = [
    {
      id: 'term', name: '定期寿险', icon: '🛡️', kind: '保障', premium: 6000,
      desc: '每年缴 6,000 元，身故/全残一次性赔付 100 万。纯保障，没有理财收益，退保几乎拿不回钱。',
      law: '保险姓保。保障型产品的作用是转移风险，不是增值；现金价值极低，早期退保损失巨大。'
    },
    {
      id: 'annuity', name: '年金险', icon: '🏦', kind: '年金', premium: 50000,
      desc: '一次性缴 5 万，锁定期长；现金价值随时间爬升，第 5 年前后回本，之后每年返还 3.5%。',
      law: '年金险收益写进合同，安全但流动性极差；犹豫期（通常 15 天）内退保全额退费，之后退保按现金价值，前期严重亏损。'
    }
  ];

  /* ---------------- 个人养老金账户 ---------------- */
  const PENSION_CAP = 12000;     // 年缴费上限 12,000 元
  const PENSION_TAX = 0.10;      // 缴费当期个税抵扣(按 10% 档简化)
  const PENSION_RATE = 0.03;     // 账户内稳健增值 3%/年

  /* ================================================================
     玩法开关 —— 默认全部开启, 玩家可在「设置」中自行调节
     ================================================================ */
  const DEF_OPT = {
    blackswan: true,     // 黑天鹅事件
    swanLevel: 3,        // 黑天鹅频率档位 0~4 (0=关闭)
    butterfly: true,     // 反后视镜蝴蝶效应
    impact: true,        // 订单冲击成本
    shortFee: true,      // 融券借券费
    divTax: true,        // 股息红利差别化个税
    news: true,          // RSS 滚动快讯条
    swanNews: true,      // 黑天鹅事件弹出播报
    micro: true,         // 市场微观结构（订单流定价）总开关
    microLevel: 'std'    // 微观结构档位: 'lite' | 'std' | 'hard'
  };

  const SWAN_LEVELS = [
    { v: 0, name: '关闭', rate: 0, note: '完全不触发黑天鹅事件（历史走势保持原样）' },
    { v: 1, name: '罕见', rate: 0.0025, note: '约每 1.6 年一次，接近真实低频极端事件' },
    { v: 2, name: '较少', rate: 0.005, note: '约每 10 个月一次' },
    { v: 3, name: '正常', rate: 0.010, note: '约每 5 个月一次（默认）' },
    { v: 4, name: '频繁', rate: 0.020, note: '约每 2.5 个月一次，市场极不稳定' }
  ];

  /* 黑天鹅事件池 —— 全部为公开宏观/行业层面的典型情形，非针对个体 */
  /* drift 为每个交易日的额外对数收益, days 为冲击窗口, vol 为额外波动倍数 */
  const SWAN_POOL = [
    {
      id: 'credit', name: '信用债违约', face: 'panic',
      scope: 'ALL', kind: 'bear', drift: -0.0042, days: 12, vol: 1.6,
      t: '某头部房企境外债实质性违约，信用利差快速走阔',
      tip: '信用收缩会通过融资链条传导到全市场，估值与流动性同时受压。'
    },
    {
      id: 'overseas', name: '海外紧缩', face: 'panic',
      scope: 'ALL', kind: 'bear', drift: -0.0036, days: 10, vol: 1.4,
      t: '海外主要央行超预期收紧，全球风险资产同步承压',
      tip: '外部流动性收紧时，高估值板块往往首当其冲。'
    },
    {
      id: 'geo', name: '地缘冲突', face: 'panic',
      scope: 'ALL', kind: 'bear', drift: -0.0048, days: 8, vol: 2.0,
      t: '地缘冲突升级，大宗商品跳涨、避险情绪主导盘面',
      tip: '地缘冲击通常来得快、去得也快，但波动会显著放大。'
    },
    {
      id: 'liquidity', name: '流动性危机', face: 'panic',
      scope: 'ALL', kind: 'bear', drift: -0.0060, days: 6, vol: 2.2,
      t: '资金面骤然收紧，短端利率飙升，机构被迫降杠杆',
      tip: '流动性危机时「能卖出去」比「卖多少钱」更重要。'
    },
    {
      id: 'flash', name: '闪崩连锁', face: 'panic',
      scope: 'ALL', kind: 'bear', drift: -0.0070, days: 3, vol: 3.0,
      t: '某宽基 ETF 盘中闪崩，触发程序化止损与连锁强平',
      tip: '杠杆在市场闪崩时会被放大成清算链条——这是最危险的一类行情。'
    },
    {
      id: 'stimulus', name: '稳增长组合拳', face: 'wide',
      scope: 'ALL', kind: 'bull', drift: 0.0038, days: 12, vol: 1.3,
      t: '稳增长一揽子政策落地，基建与消费方向预期显著改善',
      tip: '政策拐点往往先反映在预期上，再反映在盈利上。'
    },
    {
      id: 'easing', name: '全面宽松', face: 'greedy',
      scope: 'ALL', kind: 'bull', drift: 0.0034, days: 10, vol: 1.2,
      t: '央行宣布全面降准，市场流动性预期转向宽松',
      tip: '宽货币不等于宽信用，行情能走多远要看盈利能否接棒。'
    },
    {
      id: 'secbear', name: '行业监管收紧', face: 'panic',
      scope: 'IND', kind: 'bear', drift: -0.0075, days: 14, vol: 1.5,
      t: '监管部门就行业规范出台新规，相关公司短期盈利预期下修',
      tip: '行业性利空对个股的杀伤是系统性的，分散持仓能降低单点风险。'
    },
    {
      id: 'secbull', name: '行业景气爆发', face: 'greedy',
      scope: 'IND', kind: 'bull', drift: 0.0068, days: 14, vol: 1.4,
      t: '行业订单大幅超出预期，龙头公司产能利用率快速抬升',
      tip: '景气度驱动的行情往往伴随估值扩张，波动也会同步放大。'
    },
    {
      id: 'fxshock', name: '汇率剧烈波动', face: 'panic',
      scope: 'FX', kind: 'bear', drift: -0.0035, days: 9, vol: 2.4,
      t: '汇率市场出现单边快速贬值，跨境资金流动加剧',
      tip: '汇率波动会同时影响出口链、进口链与外资持仓偏好。'
    }
  ];

  /* ---------------- 固定资产 (可用于信用抵押) ---------------- */
  // value 为单位: 元; mort 为已抵押金额
  function defaultAssets() {
    return [
      { id: 'house', name: '名下住房', icon: '🏠', value: 2000000, mort: 0 },
      { id: 'shop', name: '投资商铺', icon: '🏪', value: 800000, mort: 0 },
      { id: 'car', name: '代步座驾', icon: '🚗', value: 200000, mort: 0 }
    ];
  }

  /* ---------------- 金融普法卡片 (依据我国现行法规) ---------------- */
  const LEGAL_TIPS = [
    { t: '融资融券的合法边界', b: '证券信用交易（融资融券）只能由取得证监会业务资格的证券公司开展。向不特定对象提供“场外配资”、代客操盘承诺保收益，属于非法证券活动，不受法律保护。本作里的杠杆仅为模拟。' },
    { t: '民间借贷利率司法保护上限', b: '根据《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》，借贷利率超过合同成立时一年期 LPR 四倍的部分，法院不予支持。当前约在 13% 上下。游戏内质押贷款 6%、资产抵押 4% 均在法律保护区间内。' },
    { t: '失信被执行人高消费限制', b: '《最高人民法院关于限制被执行人高消费及有关消费的若干规定》：被纳入失信名单后，不得乘坐飞机、高铁一等座以上、不得在星级酒店消费、不得购买不动产、不得旅游度假等。游戏中信用分跌破阈值即触发“高消费限制”，无法再借新钱、无法新开仓。' },
    { t: '股票交易税费', b: 'A 股卖出单边征收印花税（现行 0.05%），佣金双边不超过成交额的 0.03%（最低 5 元），沪市过户费双边万 0.1。买入不收印花税。本作已按此标准计费。' },
    { t: '维持担保比例', b: '券商融资的维持担保比例 = 总资产 ÷ 总负债。低于 130% 会被要求追加担保物，低于 100% 将被强制平仓。本作质押贷款以持仓市值 70% 为额度、负债/市值低于 100% 即强平还贷。' },
    { t: '个人征信', b: '依据《征信业管理条例》，不良信贷记录会进入金融信用信息基础数据库，影响房贷、车贷与信用卡。按时还款、控制负债率，是维护信用的根本。' },
    { t: '非法集资与诈骗识别', b: '凡是“保本保收益”“拉人头返利”“境外平台高杠杆”多半是非法集资或诈骗。《防范和处置非法集资条例》明确予以打击。记住：收益与风险永远成正比。' },
    { t: '基金与理财不是存款', b: '公募基金、ETF、银行理财均不承诺保本保收益，净值会波动。购买前须做风险测评（风险适当性管理）。游戏内所有“理财”标的均为模拟净值，仅供学习。' },
    { t: '期货交易风险更高', b: '期货采用保证金交易且双向开仓，杠杆远高于股票，价格波动可在日内让本金归零。普通投资者参与前应充分认知杠杆与到期交割风险。' },
    { t: '“砍头息”违法，本金按实付认定', b: '《民法典》第670条：借款的利息不得预先在本金中扣除；预先扣除的，应当按实际借款数额返还并计算利息。借条写1万、到手7千的“砍头息”，法律上你只欠7千。' },
    { t: '“套路贷”是刑事犯罪', b: '以非法占有为目的，假借民间借贷之名，通过虚增债务、恶意垒高金额、制造违约、暴力或软暴力索债的，构成诈骗、敲诈勒索、非法拘禁等罪。遇到“套路贷”应立即报警。' },
    { t: '暴力催收 / 软暴力催收违法', b: '《刑法》第293条之一催收非法债务罪：以暴力、胁迫、限制人身自由、侵入住宅、恐吓跟踪骚扰等方式催收高利放贷等非法债务的，可处三年以下有期徒刑。爆通讯录、短信轰炸均属违法。' },
    { t: '网贷乱象与合规红线', b: '监管部门明令禁止“无场景现金贷”、诱导过度借贷、向无还款能力人群放贷，禁止违规收取高额砍头息与罚息。《网络小额贷款业务管理暂行办法》对杠杆率、利率、催收均有约束。' },
    { t: '花呗 / 借呗 / 信用卡都上征信', b: '花呗、借呗由持牌消费金融机构提供，信用卡取现属银行业务，均会向央行征信系统报送。逾期记录保存 5 年，影响房贷、车贷、就业与高消费。免息期一过，日息 0.05%（年化约 18%）并不便宜。' },
    { t: '亲友借贷：人情也是债', b: '向同学、朋友、亲戚借款属于自然人之间借贷，受《民法典》保护。虽多无息，但“欠钱不还”伤的是关系。金额较大建议出具借条、写明还款日期；无约定利息视为无息，约定利息不得超过一年期 LPR 四倍。' },
    { t: '国债逆回购：场内“借钱收息”', b: '国债逆回购是交易所场内业务：你把钱按约定利率借给需要资金的机构，对方以国债质押。沪深均 1,000 元起、按 1,000 元整数倍申报，期限 1/2/3/4/7/14/28/91/182 天。收益 = 金额 × 年化利率 × 占款天数 ÷ 365，手续费单向收取（1 天 0.001% 至 91/182 天 0.03%，30 元封顶），不收取印花税与过户费。到期本金利息自动回款，不可提前赎回。风险极低但并非存款，利率随行就市。' },
    { t: '银行理财：净值化、打破刚兑、不保本', b: '资管新规后，银行理财全面净值化，不再承诺保本保收益。风险等级由低到高为 R1（谨慎，现金管理）→ R2（稳健，固收）→ R3（平衡，固收+权益≤30%）→ R4（进取，权益为主）→ R5（激进，可投衍生品/私募）。购买前必须做风险测评，且只能买不高于自身风险承受等级的产品。净值会下跌，可能亏损本金。' },
    { t: '可转债：T+0、免印花税，但有强赎风险', b: '可转债实行 T+0，当日买入当日可卖；以 100 元面值/张报价，1 手 = 10 张 = 1,000 元面额；上交所 11 开头、深交所 12 开头。上市首日涨跌幅为 +57.3% / -43.3%，次日起 ±20%，盘中设 20%、30% 两档临时停牌。交易仅收佣金，不收印花税与过户费。注意：可转债含“强制赎回”条款，正股价格持续高于转股价一定幅度时，发行人可按面值加利息强赎，持有人在 130 元甚至更高价位买入会瞬间巨亏。' },
    { t: '可转债打新：信用申购与弃购罚则', b: '可转债打新采用信用申购——申购时无需预缴资金、零成本，中签后按面额缴款。若中签后未按时足额缴款，即为“弃购”；连续 12 个月内累计弃购 3 次，将 6 个月内不得参与新股、可转债、可交换债的申购。本作已按此规则实现。' },
    { t: '股息红利差别化个人所得税', b: '依据财税〔2015〕101 号与财税〔2012〕85 号：个人从公开发行和转让市场取得上市公司股票，持股期限超过 1 年的，股息红利所得暂免征收个人所得税；持股 1 个月以内（含）的全额计入应纳税所得额，1 个月以上至 1 年（含）的暂减按 50% 计入，统一适用 20% 税率。即实际税负为：≤1 个月 20%、1 个月–1 年 10%、>1 年 0%。派发时对持股 1 年以内不预扣，待转让股票时按持股期限计算并从资金账户扣收。持股期限按“先进先出”原则计算。' },
    { t: '除权除息：分红不是白拿的钱', b: '上市公司派发现金红利时，会在除权除息日对股价作相应下调。分红当天你的持仓市值下降、现金增加，总资产基本不变——分红不是“白送的钱”。真正的收益来自公司持续盈利带来的价值增长。' },
    { t: '个人养老金：税优换来的是流动性锁定', b: '个人养老金账户每年缴费上限 12,000 元，缴费当期可在综合所得中据实扣除、享受个税优惠，账户内投资收益暂不征税。代价是资金封闭运行，达到法定退休年龄等特定情形才能领取，提前支取需退回税收优惠。本质是“用流动性换税优”，适合长期闲置资金。' },
    { t: '保险姓保：保障与理财要分开', b: '定期寿险、重疾险等保障型产品的现金价值极低，早期退保往往只能拿回很少的钱，它的价值在于转移风险而非增值。年金险、增额终身寿等带有储蓄性质，但锁定期长、流动性差，IRR 常常低于同期理财。先配足保障，再谈理财。' },
    { t: '黑天鹅：为什么「历史会重演」是幻觉', b: '塔勒布在《黑天鹅》中指出：重大冲击总是来自样本外的、无法从历史中读出的极端事件。本作的历史回放模式让你看到的是「已经发生过的那条路径」，但真实市场永远有新的分支——信用违约、地缘冲突、流动性枯竭、闪崩连锁。所以引擎会在历史路径上施加确定性的额外扰动（黑天鹅事件），让「照着历史抄作业」不再稳赚。这既是游戏机制，也是投资常识：不要用后视镜开车。' },
    { t: '反身性与自我实现的预言', b: '索罗斯的「反身性」理论认为，参与者的认知会反过来改变基本面。当大量资金依据同一套历史规律下注时，这套规律本身就会失效——因为交易行为已经改变了价格结构。本作用「蝴蝶效应」模拟这一点：你在历史高胜率点位反复下单，系统会逐步提高对该标的的逆向扰动强度。现实中的对应物是策略拥挤、因子失效与流动性踩踏。' },
    { t: '冲击成本：大单为什么成交价更差', b: '订单簿深度有限，单笔委托越大，吃掉的挂单越多，成交均价就越偏离中间价——这被称为「冲击成本」，学术上通常用成交量的平方根律近似（滑点 ∝ √(委托量/市场成交量)）。机构把资金拆成小单、用 VWAP/TWAP 算法分时执行，正是为了压低冲击成本。本作已按平方根律估算滑点并计入成交价。' },
    { t: '融券的借券费与挤空风险', b: '融券卖空是向券商借入证券卖出，需支付借券费（年化通常在 8%–10%，冷门券源更高），且要随时面临出借方召回。当大量空头集中、可借券源耗尽时，可能出现「挤空」（short squeeze）：股价越涨、空头越被迫买回，形成自我强化的暴涨。空头的理论最大亏损是无限的。' }
  ];

  /* ---------------- 非正规借贷 (仅供普法教育, 演示其危害) ---------------- */
  // 这些产品在法律上属于非法/不受保护范畴, 游戏内开放仅为让人「安全地体验一次陷阱」
  const ILLEGAL_LOANS = [
    {
      id: 'shark', name: '高利贷 · 砍头息', icon: '🩸', cut: 0.30, daily: 0.005, compound: false,
      term: 0,
      desc: '借 1 万，先扣 3000 “手续费”，到手只有 7000，但欠条写的还是 1 万。日息 0.5%，年化约 182%。',
      law: '年化远超一年期 LPR 四倍（约 13.8%），超出部分法院不予支持；“砍头息”依《民法典》第670条按实付本金认定。暴力催收可构成催收非法债务罪。'
    },
    {
      id: 'compound', name: '复利贷 · 利滚利', icon: '🌀', cut: 0.10, daily: 0.003, compound: true,
      term: 0,
      desc: '利息计入本金再计息，日息 0.3% 复利滚动。今天借 1 万，一年后可能变成还不起的天文数字。',
      law: '“利滚利”超出 LPR 四倍的部分不受法律保护（最高法民间借贷司法解释）。以复利方式虚增债务，是“套路贷”的典型手法。'
    },
    {
      id: 'payday', name: '网贷 · 现金贷', icon: '📱', cut: 0.20, daily: 0.002, compound: false,
      term: 14,
      desc: '7–14 天超短期，砍头息 20% + 逾期高额罚息。一旦逾期就“爆通讯录”，骚扰你所有亲友。',
      law: '禁止违规砍头息、高额罚息；爆通讯录、短信轰炸属于“软暴力催收”，依《刑法》第293条之一可能构成催收非法债务罪。'
    }
  ];

  /* ---------------- 持牌消费信贷 (合法但成本高昂) ---------------- */
  const CONSUMER_CREDIT = [
    {
      id: 'huabei', name: '花呗', icon: '🪷', cut: 0, daily: 0.0005, compound: false, term: 40, limit: 50000,
      desc: '先消费后还款，最长免息期约 40 天；逾期按日息 0.05%（年化约 18.25%）计息，并上报征信。',
      law: '花呗由持牌消费金融机构/小额贷款公司提供，属合法消费信贷。逾期会影响个人征信并可能被催收。理性消费、按时还款。'
    },
    {
      id: 'jiebei', name: '借呗', icon: '💰', cut: 0, daily: 0.00045, compound: false, term: 30, limit: 200000,
      desc: '现金贷，按日计息、随借随还，日息约 0.045%（年化约 16.4%），额度因人而异。',
      law: '借呗为持牌机构产品，合法但成本不低；逾期计罚息并影响征信。“以贷养贷”只会越陷越深。'
    },
    {
      id: 'card', name: '信用卡取现', icon: '💳', cut: 0.01, daily: 0.0005, compound: true, term: 30, limit: 100000,
      desc: '信用卡取现：一次性手续费约 1%，利息日息 0.05% 且按月复利，没有免息期。',
      law: '信用卡取现是银行合规业务，但成本高、按月复利；逾期影响征信，恶意透支长期不还可能构成信用卡诈骗罪。'
    }
  ];

  /* ---------------- 亲友借贷 (无息, 但人情最贵) ---------------- */
  const FRIEND_LOANS = [
    {
      id: 'classmate', name: '找同学借', icon: '🎓', cut: 0, daily: 0, compound: false, term: 30, trust: 8, limit: 50000,
      desc: '跟关系不错的同学开口。不收利息，但最好约定归还时间——人情比利息更贵。',
      law: '亲友间借款属自然人之间的民间借贷，受《民法典》保护。建议出具借条、写明金额与归还日期，避免日后纠纷。'
    },
    {
      id: 'friend', name: '找朋友借', icon: '🍻', cut: 0, daily: 0, compound: false, term: 45, trust: 12, limit: 100000,
      desc: '朋友是最后的流动资金。借了不还，朋友也就没了。',
      law: '自然人之间的借款合同自提供借款时生效；可约定利息（不得超过合同成立时一年期 LPR 四倍），无约定视为无息。'
    },
    {
      id: 'relative', name: '找亲戚借', icon: '🏮', cut: 0, daily: 0, compound: false, term: 60, trust: 20, limit: 300000,
      desc: '亲戚的钱最好借也最难还——因为还的是情分。往后每次家庭聚会都会被提起。',
      law: '亲属间借贷同样受法律保护。金额较大时建议书面约定，既保护债权，也维护亲情。'
    }
  ];

  const G = {
    base: BASE, realized: 0, leverage: 1, mode: 'replay',
    positions: [], trades: [], history: [], log: [],
    startIdx: 0, tradeDays: {}, addic: 0, badges: {},
    margins: 0, warned: false, ruin: false, dead: false,
    peakEquity: BASE, maxDrawdown: 0, dayTrades: 0, totalBuys: 0, totalSells: 0,
    wins: 0, losses: 0, listeners: [],
    debt: 0, debtInterest: 0, cashFund: false, loanWarned: false, _recorded: false,
    credit: CREDIT_START, assets: defaultAssets(),
    illLoans: [], illStage: 0, illCollected: 0,
    civLoans: [], relation: 100, relationWarned: false,
    /* ---- 理财类 ---- */
    repos: [],                                      // 国债逆回购持有
    wealth: [],                                     // 银行理财份额
    dca: [],                                        // 指数基金定投计划
    insures: [],                                    // 商业保险
    pension: { contributed: 0, balance: 0, year: 0, taxSaved: 0 },
    /* ---- 可转债打新 ---- */
    cbApplies: [], cbForfeit: 0, cbBanUntil: -1, cbWins: [],
    /* ---- 分红 ---- */
    divTotal: 0, divTax: 0, divLog: [],
    /* ---- 操作反作用力 (冲击成本 / 融券费 / 蝴蝶效应) ---- */
    impact: {},                 // code -> 累计冲击成本
    impactLog: [],
    shortFee: 0,                // 累计融券费用
    butterfly: 0,               // 反后视镜强度 0~1
    hindsight: 0, auditN: 0,    // 后视镜命中 / 已审计次数
    bSeed: '', bStart: {},      // 蝴蝶扰动种子 / 各标的扰动起点
    microCarry: {},             // 微观结构：玩家冲击累积量 { code: [[idx,carry], …] }（进存档）
    /* ---- 黑天鹅事件 ---- */
    swans: [], swanLog: [], swanSeq: 0,
    /* ---- 玩法开关 (默认全开, 可在「设置」中调节) ---- */
    opt: null                   // 由 reset() 填充 = 深拷贝 DEF_OPT
  };

  const emit = (ev, data) => G.listeners.forEach(f => f(ev, data || {}));

  /* ---------------- 费用 ---------------- */
  /* 可转债: 仅佣金, 免印花税、免过户费 */
  function buyFee(amount, code) {
    if (code && Market.isCB(code)) return Math.max(CB_FEE_MIN, amount * CB_FEE_RATE);
    let f = Math.max(FEE_MIN, amount * FEE_RATE);
    if (code && code.indexOf('sh') === 0) f += amount * TRANSFER_RATE;
    return f;
  }
  function sellFee(amount, code) {
    if (code && Market.isCB(code)) return Math.max(CB_FEE_MIN, amount * CB_FEE_RATE);
    let f = Math.max(FEE_MIN, amount * FEE_RATE);
    f += amount * TAX_RATE;
    if (code && code.indexOf('sh') === 0) f += amount * TRANSFER_RATE;
    return f;
  }

  /* 最小交易单位: 可转债 10 张(1手), 其余 100 股 */
  function lot(code) { return (code && Market.isCB(code)) ? CB_LOT : 100; }

  /* 账户派生量 —— 理财类资产 (现金买入但未体现在 realized 里的部分) */
  function repoValue() { return G.repos.reduce((s, r) => s + r.amount, 0); }
  function wealthValue() { return G.wealth.reduce((s, w) => s + w.shares * Market.price(w.code), 0); }
  function pensionBal() { return G.pension.balance || 0; }
  function insuranceCV() { return G.insures.reduce((s, i) => s + i.cashValue, 0); }
  function cashAssets() {
    return repoValue() + wealthValue() + pensionBal() + insuranceCV();
  }

  /* ---------------- 账户派生量 ---------------- */
  /* 注: px() 为「影子价格」, 蝴蝶强度为 0 时严格等于 Market.price */
  function marketValue() {
    return G.positions.reduce((s, p) => s + px(p.code) * p.shares, 0);
  }
  function unrealized() {
    return G.positions.reduce((s, p) => {
      const diff = (p.side === 'short')
        ? (p.cost - px(p.code))
        : (px(p.code) - p.cost);
      return s + diff * p.shares;
    }, 0);
  }
  function debtTotal() { return G.debt + G.debtInterest; }
  function illTotal() { return G.illLoans.reduce((s, l) => s + l.owed, 0); }
  function civTotal() { return G.civLoans.reduce((s, l) => s + l.owed, 0); }
  function totalDebt() { return debtTotal() + illTotal() + civTotal(); }
  /* 理财类资产(逆回购/银行理财/养老金/保险现金价值)计入净资产, 但会占用可用资金 */
  function equity() {
    return G.base + G.realized + unrealized() - debtTotal() - illTotal() - civTotal()
      + cashAssets();
  }
  function usedMargin() {
    const L = Math.max(1, G.leverage);
    return G.positions.reduce((s, p) => s + px(p.code) * p.shares / L, 0);
  }
  function loanAvail() { return Math.max(0, marketValue() * LOAN_LTV - debtTotal()); }
  function avail() { return equity() - usedMargin() - cashAssets(); }
  function marginRatio() {
    const m = usedMargin();
    if (m <= 0.0001) return null;
    return equity() / m * 100;
  }

  function summary() {
    const eq = equity(), mv = marketValue(), un = unrealized();
    const cost = G.positions.reduce((s, p) => s + p.cost * p.shares, 0);
    return {
      equity: eq, avail: avail(), mv, unrealized: un,
      returnPct: (eq - G.base) / G.base * 100,
      unrealizedPct: cost ? un / cost * 100 : 0,
      marginRatio: marginRatio(), leverage: G.leverage,
      ruin: G.ruin, base: G.base, realized: G.realized,
      debt: G.debt, debtInterest: G.debtInterest, debtTotal: debtTotal(),
      loanAvail: loanAvail(), cashFund: G.cashFund, loanRate: G.loanRate || LOAN_RATE,
      credit: G.credit, mortAvail: mortAvail(), assets: G.assets,
      creditBad: creditBlocked() !== null,
      illDebt: illTotal(), illLoans: G.illLoans, illStage: G.illStage,
      civDebt: civTotal(), civLoans: G.civLoans, relation: G.relation,
      totalDebt: totalDebt(),
      /* ---- 理财类 ---- */
      repoVal: repoValue(), repos: G.repos,
      wealthVal: wealthValue(), wealth: G.wealth,
      pensionVal: pensionBal(), pension: G.pension,
      insureCV: insuranceCV(), insures: G.insures,
      dca: G.dca,
      cashAssets: cashAssets(),
      /* ---- 可转债 / 分红 ---- */
      cbApplies: G.cbApplies, cbForfeit: G.cbForfeit, cbBanUntil: G.cbBanUntil,
      cbBanned: Market.idx < G.cbBanUntil,
      divTotal: G.divTotal, divTax: G.divTax,
      /* ---- 操作反作用力 ---- */
      butterfly: G.butterfly, hindsight: G.hindsight, shortFee: G.shortFee,
      impact: G.impact,
      /* ---- 黑天鹅 / 设置 ---- */
      swans: G.swans, swanLog: G.swanLog, opt: G.opt,
      activeSwans: activeSwans()
    };
  }

  /* ---------------- 涨跌停 ----------------
     全部以「影子价格」口径给出: 翅膀/黑天鹅扰动会整体平移价格网格 */
  function limits(code) {
    const meta = Market.metaOf(code);
    const k = kAt(code, Market.idx);
    const pc0 = Market.prevClose(code);
    const pc = pc0 * k;
    if (!pc0) return { up: Infinity, down: 0, pc: 0, pct: meta ? meta.limitPct : 10 };
    const q = Market.S.quotes[code];
    if (Market.S.mode === 'live' && q && q.limitUp > 0) {
      return { up: q.limitUp * k, down: q.limitDown * k, pc, pct: meta ? meta.limitPct : 10 };
    }
    /* 可转债上市首日: +57.3% / -43.3%; 次日起 +-20% (走 meta.limitPct)
       limitPct 是单值, 无法表达「首日 vs 次日起」双规则, 故在此特判 */
    if (Market.isCB(code)) {
      const li = Market.listIdx(code);
      if (li >= 0 && Market.idx === li) {
        return {
          up: Math.round(pc * (1 + CB_FIRST_UP / 100) * 100) / 100,
          down: Math.round(pc * (1 - CB_FIRST_DOWN / 100) * 100) / 100,
          pc, pct: CB_FIRST_UP, firstDay: true
        };
      }
    }
    const pct = meta ? meta.limitPct : 10;
    if (pct <= 0) return { up: Infinity, down: 0, pc, pct: 0 };
    const up = Math.round(pc * (1 + pct / 100) * 100) / 100;
    const down = Math.round(pc * (1 - pct / 100) * 100) / 100;
    return { up, down, pc, pct };
  }

  /* ---------------- 交易 ---------------- */
  function pos(code) { return G.positions.find(p => p.code === code); }

  function sellable(code) {
    const p = pos(code); if (!p) return 0;
    const day = Market.date();
    if (G.mode === 'live') return (p.buyDays && p.buyDays.includes(day)) ? 0 : p.shares;
    return p.shares; // 回放模式: 当日买入次日可售 -> 用 openIdx 判定
  }

  function canSellShares(code) {
    const p = pos(code); if (!p) return 0;
    if (G.t0) return p.shares;                       // 已解除 T+1
    if (Market.isCB(code)) return p.shares;          // 可转债本身即 T+0
    if (G.mode === 'live') {
      return (p.buyDays && p.buyDays.indexOf(Market.date()) >= 0) ? 0 : p.shares;
    }
    return (p.lastBuyIdx !== undefined && p.lastBuyIdx >= Market.idx) ? 0 : p.shares;
  }

  /* ---------------- 开仓路由 ---------------- */
  function buy(code, price, shares, side) {
    side = side || 'long';
    const cb = creditBlocked();
    if (cb) return ok(false, cb);
    const p = pos(code);
    if (p && p.shares > 0 && p.side !== side) {
      return ok(false, side === 'short' ? '你已持有多单，请先平仓再开空' : '你已持有空单，请先平仓再开多');
    }
    return side === 'short' ? openShort(code, price, shares) : buyLong(code, price, shares);
  }

  function buyLong(code, price, shares) {
    const meta = Market.metaOf(code);
    if (!meta || !meta.tradable) return ok(false, Market.isRepo(code) || Market.isWealth(code)
      ? '该品种请到「理财中心」操作' : '指数不可交易');
    const L = lot(code);
    shares = Math.floor(shares / L) * L;
    if (shares < L) return ok(false, Market.isCB(code) ? '可转债最小 1 手（10 张）' : '最小交易单位为 100 股');
    const bar = Market.bar(code);
    if (!bar) return ok(false, '无行情数据');
    const k = kAt(code, Market.idx);
    const lo = bar.l * k, hi = bar.h * k;
    const lim = limits(code);
    if (price > lim.up + 1e-6) return ok(false, '涨停板上买不到…排队也不一定能成交');
    if (price < lim.down - 1e-6) return ok(false, '低于跌停价，委托无效');
    if (price < lo - 1e-6) return ok(false, '当日最低价 ' + lo.toFixed(2) + '，你的限价挂得太低没成交');

    /* 实际成交价: 大额单子会被自己的冲击推高 */
    const fp = fillPrice(code, shares, price, true);
    const fill = fp.price;
    const amount = fill * shares;
    const fee = buyFee(amount, code);
    const need = amount / G.leverage + fee;
    if (need > avail() + 1e-6) {
      return ok(false, G.leverage > 1
        ? '保证金不足 (需 ' + money(amount / G.leverage + fee) + ')'
        : '可用资金不足 (需 ' + money(need) + ')');
    }
    noteImpact(code, shares, fee, fp.slip);
    /* 微观结构：玩家买入净流 → Kyle λ → carry（正号推高） */
    if (window.Micro && typeof Micro.applyPlayerFlow === 'function') Micro.applyPlayerFlow(G, code, amount);

    const existing = pos(code);
    if (existing) {
      const total = existing.shares + shares;
      existing.cost = (existing.cost * existing.shares + amount + fee) / total;
      existing.shares = total;
      existing.buyDays = existing.buyDays || [];
      if (existing.buyDays.indexOf(Market.date()) < 0) existing.buyDays.push(Market.date());
      existing.lastBuyIdx = Market.idx;
      existing.lots = existing.lots || [];
      existing.lots.push({ shares, idx: Market.idx });
      existing.audit = true; existing.auditIdx = Market.idx;
    } else {
      G.positions.push({
        code, shares, cost: (amount + fee) / shares, side: 'long',
        openIdx: Market.idx, buyDays: [Market.date()], lastBuyIdx: Market.idx,
        lots: [{ shares, idx: Market.idx }], divs: [],
        audit: true, auditIdx: Market.idx
      });
    }
    if (G.butterfly > 0.001) {
      G.bStart[code] = Market.idx;            // 重新起算蝴蝶扰动
      clearButterflyCache();
    }
    G.realized -= fee;
    G.totalBuys++;
    G.addic = Math.min(100, G.addic + 2.2);
    if (G.leverage >= 5) G.addic = Math.min(100, G.addic + 2);
    const unit = Market.isCB(code) ? '张' : '股';
    log('买入', code, meta.name, shares + unit + ' @' + fill.toFixed(2) +
      (fp.slip > 0.0005 ? '（冲击成本 ' + (fp.slip * 100).toFixed(2) + '%）' : ''), 'up');
    G.trades.push({ side: 'B', code, name: meta.name, price, shares, fee, day: Market.date(), idx: Market.idx });
    award('first_trade');
    if (Market.isCB(code)) award('cb_first');
    if (G.leverage >= 10) award('high_roller');
    if (G.positions.length >= 5) award('diversified');
    if (activeSwans().some(s => s.kind === 'bear')) award('swan_ride');
    checkTday();
    after();
    return ok(true, '买入成交 ' + meta.name + ' ' + shares + ' ' + unit);
  }

  function openShort(code, price, shares) {
    const meta = Market.metaOf(code);
    if (!meta || !meta.tradable) return ok(false, '指数不可交易');
    const L = lot(code);
    shares = Math.floor(shares / L) * L;
    if (shares < L) return ok(false, Market.isCB(code) ? '可转债最小 1 手（10 张）' : '最小交易单位为 100 股');
    const bar = Market.bar(code);
    if (!bar) return ok(false, '无行情数据');
    const k = kAt(code, Market.idx);
    const hi = bar.h * k;
    const lim = limits(code);
    if (price > lim.up + 1e-6) return ok(false, '涨停板上开不了空（没人接盘）');
    if (price < lim.down - 1e-6) return ok(false, '跌停板上开不了空');
    if (price > hi + 1e-6) return ok(false, '当日最高价 ' + hi.toFixed(2) + '，挂太高没成交');

    const fp = fillPrice(code, shares, price, false);   // 融券卖出 -> 冲击压低
    const fill = fp.price;
    const amount = fill * shares;
    const fee = buyFee(amount, code);  // 融券卖出: 佣金+过户, 无印花税
    const need = amount / G.leverage + fee;
    if (need > avail() + 1e-6) {
      return ok(false, G.leverage > 1
        ? '保证金不足 (需 ' + money(amount / G.leverage + fee) + ')'
        : '可用资金不足 (需 ' + money(need) + ')');
    }
    noteImpact(code, shares, fee, fp.slip);
    /* 微观结构：融券卖出净流 → Kyle λ → carry（负号压低） */
    if (window.Micro && typeof Micro.applyPlayerFlow === 'function') Micro.applyPlayerFlow(G, code, -amount);

    const existing = pos(code);
    if (existing) {
      const total = existing.shares + shares;
      existing.cost = (existing.cost * existing.shares + amount - fee) / total;
      existing.shares = total;
      existing.buyDays = existing.buyDays || [];
      if (existing.buyDays.indexOf(Market.date()) < 0) existing.buyDays.push(Market.date());
      existing.lastBuyIdx = Market.idx;
      existing.audit = true; existing.auditIdx = Market.idx;
    } else {
      G.positions.push({
        code, shares, cost: (amount - fee) / shares, side: 'short',
        openIdx: Market.idx, buyDays: [Market.date()], lastBuyIdx: Market.idx,
        lots: [], divs: [], audit: true, auditIdx: Market.idx
      });
    }
    if (G.butterfly > 0.001) {
      G.bStart[code] = Market.idx;
      clearButterflyCache();
    }
    G.realized -= fee;
    G.totalBuys++;
    G.addic = Math.min(100, G.addic + 2.4);
    if (G.leverage >= 5) G.addic = Math.min(100, G.addic + 2);
    log('开空', code, meta.name, shares + (Market.isCB(code) ? '张' : '股') + ' @' + price.toFixed(2), 'down');
    G.trades.push({ side: 'S_OPEN', code, name: meta.name, price, shares, fee, day: Market.date(), idx: Market.idx });
    award('first_short');
    if (G.leverage >= 10) award('high_roller');
    checkTday();
    after();
    return ok(true, '开空成交 ' + meta.name + ' ' + shares + ' 股');
  }

  function sell(code, price, shares) {
    const p = pos(code);
    if (!p || p.shares <= 0) return ok(false, '你还没持有这只股票');
    return (p.side === 'short') ? coverShort(code, price, shares) : sellLong(code, price, shares);
  }

  function sellLong(code, price, shares) {
    const meta = Market.S.meta.find(m => m.code === code);
    const p = pos(code);
    if (!p) return ok(false, '你还没持有这只股票');
    const can = canSellShares(code);
    if (can <= 0) return ok(false, 'T+1 规则：今天买入的明天才能卖');
    const L = lot(code);
    shares = Math.floor(shares / L) * L;
    if (shares < L) return ok(false, Market.isCB(code) ? '可转债最小 1 手（10 张）' : '卖出数量至少 100 股');
    shares = Math.min(shares, can, p.shares);
    const bar = Market.bar(code);
    const lim = limits(code);
    if (price < lim.down - 1e-6) return ok(false, '跌停板砸不出来…今天卖不掉');
    if (price > lim.up + 1e-6) return ok(false, '高于涨停价，委托无效');
    if (bar && price > bar.h * kAt(code, Market.idx) + 1e-6) {
      return ok(false, '当日最高价 ' + (bar.h * kAt(code, Market.idx)).toFixed(2) + '，挂得太高没成交');
    }

    const fp = fillPrice(code, shares, price, false);
    const fill = fp.price;
    const amount = fill * shares;
    const fee = sellFee(amount, code);
    const costAll = p.cost * shares;
    const pnl = amount - costAll - fee;
    /* 红利税: 派发时不预扣, 转让时按持股期限补缴 (先进先出) */
    const dtax = dividendTaxFIFO(p, shares);
    G.realized += pnl - dtax;
    consumeLots(p, shares);
    noteImpact(code, shares, fee, fp.slip);
    /* 微观结构：卖出净流 → Kyle λ → carry（负号压低） */
    if (window.Micro && typeof Micro.applyPlayerFlow === 'function') Micro.applyPlayerFlow(G, code, -amount);
    if (dtax > 0) {
      G.divTax += dtax;
      log('红利税', code, meta ? meta.name : code, '按持股期限补缴红利税 ' + money(dtax), 'warn');
    }
    p.shares -= shares;
    if (p.shares <= 0) {
      G.positions = G.positions.filter(x => x.code !== code);
      delete G.bStart[code]; clearButterflyCache();
    }
    G.totalSells++;
    if (pnl > 0) { G.wins++; G.addic = Math.min(100, G.addic + 1.2); }
    else { G.losses++; G.addic = Math.max(0, G.addic - 1.5); }
    if (pnl / costAll > 0.3) award('big_win');
    log(pnl >= 0 ? '卖出' : '割肉', code, meta ? meta.name : code,
      shares + (Market.isCB(code) ? '张' : '股') + ' @' + fill.toFixed(2) +
      ' 盈亏' + (pnl >= 0 ? '+' : '') + money(pnl), pnl >= 0 ? 'up' : 'down');
    G.trades.push({ side: 'S', code, name: meta ? meta.name : code, price, shares, fee, pnl, day: Market.date(), idx: Market.idx });
    after();
    return ok(true, (pnl >= 0 ? '盈利了结 +' : '止损离场 ') + money(pnl), pnl >= 0 ? 'ok' : 'bad');
  }

  function coverShort(code, price, shares) {
    const meta = Market.S.meta.find(m => m.code === code);
    const p = pos(code);
    if (!p) return ok(false, '你还没持有这只股票');
    const can = canSellShares(code);
    if (can <= 0) return ok(false, 'T+1 规则：今天开的空明天才能平');
    shares = Math.floor(shares / 100) * 100;
    if (shares < 100) return ok(false, '平仓数量至少 100 股');
    shares = Math.min(shares, can, p.shares);
    const bar = Market.bar(code);
    const lim = limits(code);
    if (price < lim.down - 1e-6) return ok(false, '跌停板买不回来…今天平不掉');
    if (price > lim.up + 1e-6) return ok(false, '高于涨停价，委托无效');
    if (bar && price > bar.h * kAt(code, Market.idx) + 1e-6) {
      return ok(false, '当日最高价 ' + (bar.h * kAt(code, Market.idx)).toFixed(2) + '，挂太高没成交');
    }

    const fp = fillPrice(code, shares, price, true);   // 买券还券 -> 冲击推高
    const fill = fp.price;
    const amount = fill * shares;
    const fee = buyFee(amount, code);  // 买券还券: 佣金+过户, 无印花税
    const costAll = p.cost * shares;
    const pnl = (costAll - amount) - fee;
    G.realized += pnl;
    consumeLots(p, shares);
    noteImpact(code, shares, fee, fp.slip);
    /* 微观结构：买券还券净流 → Kyle λ → carry（正号推高） */
    if (window.Micro && typeof Micro.applyPlayerFlow === 'function') Micro.applyPlayerFlow(G, code, amount);
    p.shares -= shares;
    if (p.shares <= 0) {
      G.positions = G.positions.filter(x => x.code !== code);
      delete G.bStart[code]; clearButterflyCache();
    }
    G.totalSells++;
    if (pnl > 0) { G.wins++; G.addic = Math.min(100, G.addic + 1.2); award('short_win'); }
    else { G.losses++; G.addic = Math.max(0, G.addic - 1.5); }
    if (pnl / costAll > 0.3) award('big_win');
    log(pnl >= 0 ? '平空' : '空单止损', code, meta ? meta.name : code,
      shares + '股 @' + fill.toFixed(2) + ' 盈亏' + (pnl >= 0 ? '+' : '') + money(pnl), pnl >= 0 ? 'up' : 'down');
    G.trades.push({ side: 'S_CLOSE', code, name: meta ? meta.name : code, price, shares, fee, pnl, day: Market.date(), idx: Market.idx });
    after();
    return ok(true, (pnl >= 0 ? '空单了结 +' : '空单止损 ') + money(pnl), pnl >= 0 ? 'ok' : 'bad');
  }

  function closeAll(reason) {
    if (!G.positions.length) return [];
    const list = G.positions.slice();
    const out = [];
    list.forEach(p => {
      const shares = p.shares;
      const isBuy = p.side === 'short';               // 平空 = 买回
      const fp = fillPrice(p.code, shares, px(p.code), isBuy);
      const price = fp.price;
      const amount = price * shares;
      const fee = (p.side === 'short' ? buyFee : sellFee)(amount, p.code);
      const pnl = (p.side === 'short')
        ? (p.cost * shares - amount - fee)
        : (amount - p.cost * shares - fee);
      const dtax = (p.side === 'short') ? 0 : dividendTaxFIFO(p, shares);
      G.realized += pnl - dtax;
      G.divTax += dtax;
      consumeLots(p, shares);
      out.push({ code: p.code, shares, price, pnl, dtax });
      const meta = Market.metaOf(p.code);
      log(reason === 'cut' ? '强制平仓' : '卖出', p.code, meta ? meta.name : p.code,
        shares + (Market.isCB(p.code) ? '张' : '股') + ' @' + price.toFixed(2) +
        ' 盈亏' + (pnl >= 0 ? '+' : '') + money(pnl) +
        (dtax > 0 ? '（含补缴红利税 ' + money(dtax) + '）' : ''), 'down');
    });
    G.positions = [];
    G.bStart = {}; clearButterflyCache();
    G.losses++;
    after();
    return out;
  }

  /* ---------------- 每日结算 ----------------
     按「逐日」推进: 除权派现、可转债中签、黑天鹅抽取、定投、逆回购到期
     都绑定在具体的交易日上, 一次性推进多天必须逐日结算才不会漏事件。 */
  function stepDay(n) {
    n = n || 1;
    let moved = 0;
    for (let k = 0; k < n; k++) {
      const realN = Market.next(1);
      if (realN <= 0) break;
      moved += realN;
      /* 微观结构：玩家当日净流 → Kyle λ → 引力锚(OU) carry 递推（micro 关闭时整段短路） */
      if (window.Micro && typeof Micro.step === 'function') Micro.step(G, Market.idx);
      accrueInterest(1);
      settleDividends();       // 除权除息派现 (派发时不预扣税)
      cbResolve();             // 可转债打新中签 / 缴款 / 弃购
      rollSwan();              // 黑天鹅事件抽取 (确定性, 存盘可复现)
      G.dayTrades = 0;
      snapshotHistory();
      check();
      auditHindsight();        // 反后视镜审计 -> 蝴蝶效应
      emitDay();
      if (G.ruin || G.dead) break;   // 已退場, 不再推进
    }
    return moved;
  }

  function accrueInterest(days) {
    days = days || 1;
    // 现金理财: 闲钱投货币基金, 按日计息 (~2% 年化)
    if (G.cashFund) {
      const idle = Math.max(0, avail());
      if (idle > 0) G.realized += idle * (FUND_RATE / 252) * days;
    }
    // 质押贷款: 按日计息 (年化 LOAN_RATE)
    if (G.debt > 0) {
      G.debtInterest += G.debt * ((G.loanRate || LOAN_RATE) / 252) * days;
    }
    accrueIllegal(days);
    accrueCivil(days);
    creditTick(days);
    /* ---- 理财类日结 ---- */
    settleRepos();             // 逆回购到期自动回款
    accrueShort(days);         // 融券借券费
    accrueInsurance();         // 保险现金价值 / 年金返还
    accruePension(days);       // 养老金账户增值
    runDca();                  // 指数基金定投
  }

  function snapshotHistory() {
    const i = Market.idx;
    if (G.history.length && G.history[G.history.length - 1].i === i) {
      G.history[G.history.length - 1].eq = equity();
      return;
    }
    G.history.push({ i, eq: equity(), bench: Market.benchLevel(i) });
  }

  function emitDay() {
    /* 检查持仓事件 (以影子价格口径判定, 与玩家看到的行情一致) */
    G.positions.forEach(p => {
      const c = pxChg(p.code);
      if (c.pct >= 9.8) award('first_limit'), emit('limitUp', { code: p.code });
      if (c.pct <= -9.8) award('first_limit_down'), emit('limitDown', { code: p.code });
    });
  }

  /* 维持率检查 → 追加保证金 → 强制平仓 */
  function check() {
    const mr = marginRatio();
    const eq = equity();
    G.peakEquity = Math.max(G.peakEquity, eq);
    G.maxDrawdown = Math.max(G.maxDrawdown, (G.peakEquity - eq) / G.peakEquity * 100);

    if (G.leverage > 1 && mr !== null) {
      if (mr <= 130) {
        award('margin_call');
        if (!G.warned || mr <= 115) {
          G.warned = true;
          log('系统', '', '维持率', '维持担保比例 ' + mr.toFixed(1) + '% ⚠ 請尽快追加保证金', 'warn');
          emit('marginCall', { mr });
        }
      } else if (mr > 180) G.warned = false;

      if (mr <= 100) {
        const out = closeAll('cut');
        G.margins++;
        award('blown');
        updateCredit(-40);
        emit('losscut', { mr, closed: out });
      }
    }

    if (G.debt > 0) checkLoan();
    checkCollect();
    checkCivil();

    if (eq <= G.base * 0.05) {
      G.ruin = true; G.dead = true;
      award('gameover');
      updateCredit(-100);
      emit('ruin', {});
    }
  }

  /* 质押贷款: 以维持担保比例监控, 跌破则强制平仓还贷 */
  function checkLoan() {
    const mv = marketValue();
    const ratio = debtTotal() > 0 ? mv / debtTotal() : Infinity;
    if (ratio < 1.0) {
      const closed = forceRepay();
      G.margins++;
      award('loan_blown');
      emit('loancut', { ratio, closed });
      log('系统', '', '融资', '质押维持率 ' + (ratio * 100).toFixed(0) + '% < 100%，强制平仓还贷', 'warn');
    } else if (ratio < 1.3) {
      if (!G.loanWarned) {
        G.loanWarned = true;
        log('系统', '', '融资', '质押维持率 ' + (ratio * 100).toFixed(0) + '% ⚠ 请及时还款', 'warn');
        emit('loanWarn', { ratio });
      }
    } else G.loanWarned = false;
  }

  function forceRepay() {
    const out = closeAll('loan');
    const pay = Math.min(debtTotal(), Math.max(0, G.realized));
    G.realized -= pay;
    G.debt = Math.max(0, G.debt - pay);
    if (G.debt <= 0) { G.debt = 0; G.debtInterest = 0; }
    updateCredit(-60);
    return out;
  }

  /* ---------------- 质押贷款 (实时抵押借现金) ---------------- */
  function pledge(amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入借款金额');
    const cb = creditBlocked();
    if (cb) return ok(false, cb);
    if (amount > loanAvail() + 1e-6) return ok(false, '可质押额度不足 (当前可贷 ' + money(loanAvail()) + ')');
    G.realized += amount;   // 现金入账
    G.debt += amount;
    G.addic = Math.min(100, G.addic + 1);
    log('融资', '', '质押贷款', '借入 ' + money(amount) + ' (年化 ' + ((G.loanRate || LOAN_RATE) * 100).toFixed(0) + '%)', 'up');
    award('first_loan');
    updateCredit(-3);
    after();
    return ok(true, '已借入 ' + money(amount));
  }
  function repay(amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入还款金额');
    const pay = Math.min(amount, debtTotal());
    if (pay <= 0) return ok(false, '当前无负债');
    G.realized -= pay;
    G.debt = Math.max(0, G.debt - pay);
    if (G.debt <= 0) G.debtInterest = 0;
    log('融资', '', '还款', '偿还 ' + money(pay), 'down');
    after();
    return ok(true, '已偿还 ' + money(pay));
  }
  function setCashFund(v) { G.cashFund = !!v; save(); emit('change', {}); }

  /* ---------------- 信用分 ---------------- */
  // 信用分 < CREDIT_BAD 触发「高消费限制」：不能再借新钱、不能再新开仓
  function creditBlocked() {
    if (G.credit < CREDIT_BAD) return '信用分 ' + Math.round(G.credit) + ' 已跌破阈值 ' + CREDIT_BAD +
      '，触发高消费限制：无法新开仓、无法新增借款。请先还款修复信用。';
    return null;
  }
  function updateCredit(delta) {
    G.credit = Math.max(300, Math.min(CREDIT_START + 50, G.credit + delta));
    G.credit = Math.round(G.credit * 10) / 10;
    if (G.credit < CREDIT_BAD) award('credit_bad');
    save();
  }
  function creditTick(days) {
    days = days || 1;
    for (let i = 0; i < days; i++) {
      if (debtTotal() <= 0) G.credit = Math.min(CREDIT_START, G.credit + 1);
      else {
        const r = debtTotal() / Math.max(1, equity());
        if (r > 0.6) G.credit = Math.max(300, G.credit - 1);
        else G.credit = Math.min(CREDIT_START, G.credit + 0.5);
      }
    }
    G.credit = Math.round(G.credit * 10) / 10;
  }

  /* ---------------- 固定资产信用抵押 ---------------- */
  function mortAvail() {
    return G.assets.reduce((s, a) => s + Math.max(0, a.value * MORT_LTV - a.mort), 0);
  }
  function mortgage(assetId, amount) {
    const cb = creditBlocked();
    if (cb) return ok(false, cb);
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入借款金额');
    const a = G.assets.find(x => x.id === assetId);
    if (!a) return ok(false, '未找到该资产');
    const maxMort = Math.floor(a.value * MORT_LTV - a.mort);
    if (amount > maxMort + 1) return ok(false, '该资产可抵押额度不足 (当前可贷 ' + money(maxMort) + ')');
    G.realized += amount;     // 现金入账
    G.debt += amount;
    a.mort += amount;
    updateCredit(-2);
    log('融资', '', '资产抵押', a.icon + a.name + ' 抵押借入 ' + money(amount) +
      ' (年化 ' + (MORT_RATE * 100).toFixed(0) + '%)', 'up');
    award('first_mort');
    after();
    return ok(true, '已用「' + a.name + '」抵押借入 ' + money(amount));
  }
  function redeem(assetId, amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入还款金额');
    const a = G.assets.find(x => x.id === assetId);
    if (!a) return ok(false, '未找到该资产');
    if (a.mort <= 0) return ok(false, '该资产没有抵押负债');
    const pay = Math.min(amount, a.mort, debtTotal());
    if (pay <= 0) return ok(false, '当前无负债');
    G.realized -= pay;
    G.debt = Math.max(0, G.debt - pay);
    if (G.debt <= 0) { G.debt = 0; G.debtInterest = 0; }
    a.mort = Math.max(0, a.mort - pay);
    log('融资', '', '资产赎楼', '偿还 ' + a.icon + a.name + ' 抵押 ' + money(pay), 'down');
    // 还款修复信用
    if (debtTotal() <= 0) updateCredit(3);
    after();
    return ok(true, '已偿还「' + a.name + '」抵押 ' + money(pay));
  }

  /* ================================================================
     操作的反作用力
     1) 冲击成本 —— 单子相对该标的近期成交量越大, 成交价越差
     2) 融券费用 —— 持有空单每日计提借券费 (年化 8%)
     3) 蝴蝶效应 —— 屡屡「后视镜式」踩准历史, 市场对该标的施加逆向扰动
     ================================================================ */
  const SHORT_FEE_RATE = 0.08;    // 融券年化费率

  /* 成交量占比 -> 冲击成本 (平方根律, 单边上限 2.5%) */
  function impactSlip(code, shares) {
    if (G.opt && G.opt.impact === false) return { ratio: 0, slip: 0 };
    const avg = Market.avgVol(code, 60);
    if (avg <= 0) return { ratio: 0, slip: 0 };
    const m = Market.metaOf(code);
    const mult = (m && m.market === 'cb') ? CB_LOT : 100;   // 快照量 -> 股/张
    const liquidity = avg * mult;
    if (liquidity <= 0) return { ratio: 0, slip: 0 };
    const ratio = shares / liquidity;
    return { ratio, slip: Math.min(0.025, Math.sqrt(Math.max(0, ratio)) * 0.20) };
  }

  /* 实际成交价: 买入上滑、卖出下滑, 并夹在该日「影子」区间内 */
  function fillPrice(code, shares, ref, isBuy) {
    const k = kAt(code, Market.idx);
    const b = Market.bar(code);
    const slip = impactSlip(code, shares).slip;
    let f = isBuy ? ref * (1 + slip) : ref * (1 - slip);
    if (b) f = Math.max(b.l * k, Math.min(b.h * k, f));
    return { price: f, slip };
  }

  function noteImpact(code, shares, fee0, slip) {
    if (slip <= 0.0005) return;
    const m = Market.metaOf(code);
    const name = m ? m.name : code;
    G.impact[code] = (G.impact[code] || 0) + slip;
    G.impactLog.unshift({ code, name, slip, day: Market.date() });
    if (G.impactLog.length > 40) G.impactLog.length = 40;
    if (slip >= 0.004) {
      log('冲击', code, name, '单子偏大，冲击成本约 ' + (slip * 100).toFixed(2) +
        '%（成交量占比 ' + (impactSlip(code, shares).ratio * 100).toFixed(2) + '%）', 'warn');
    }
    if (slip >= 0.015) award('shock');
  }

  function accrueShort(days) {
    if (G.opt && G.opt.shortFee === false) return;
    days = days || 1;
    let total = 0;
    G.positions.forEach(p => {
      if (p.side !== 'short') return;
      const mv = Market.price(p.code) * p.shares;
      total += mv * (SHORT_FEE_RATE / 252) * days;
    });
    if (total > 0) { G.realized -= total; G.shortFee += total; }
  }

  /* ---- 确定性哈希 ----
     注: 纯 FNV-1a 的尾部雪崩不足——对「前缀相同、仅末位递增」的字符串
     (如 '#swan?at260' / '#swan?at261') 会产生明显相关性, 导致抽签结果成串出现。
     这里补一轮 murmur3 的 fmix32 终混, 保证低比特也充分扩散。 */
  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  const bfacCache = {};
  /* 从开仓日开始的确定性扰动乘子: 开仓当日恒为 1, 之后随机游走
     注: 传入 i 可取得「第 i 个交易日」的累计乘子 (影子价格需要时间维度) */
  function bfactorAt(code, i) {
    if (!G.opt || !G.opt.butterfly || G.butterfly <= 0.001) return 1;
    const ii = (i === undefined) ? Market.idx : i;
    let base = G.bStart[code];
    if (base === undefined) {
      /* 蝴蝶在持仓之后才被激活 -> 从实际开仓日起算, 避免旧仓位逃逸扰动 */
      const p = pos(code);
      if (!p) return 1;
      base = p.openIdx || Market.idx;
      G.bStart[code] = base;
    }
    if (ii <= base) return 1;
    const key = code + '@' + ii;
    const hit = bfacCache[key];
    if (hit !== undefined) return hit;
    let k = 1;
    for (let d = base + 1; d <= ii; d++) {
      const s = (G.bSeed || '0') + '|' + code + '|' + d;
      const n = (hash01(s + 'a') + hash01(s + 'b') + hash01(s + 'c')) / 3 - 0.5;
      k = Math.max(0.70, Math.min(1.30, k * (1 + n * 2 * G.butterfly * 0.030)));
    }
    bfacCache[key] = k;
    return k;
  }
  function bfactor(code) { return bfactorAt(code, Market.idx); }
  function clearButterflyCache() {
    for (const k in bfacCache) delete bfacCache[k];
    swanCacheClear();
  }

  /* ================================================================
     黑天鹅事件 —— 由种子 + 日期确定性生成, 存盘后仍可复现
     事件通过「影子价格乘子」作用于市场, 不修改任何真实历史数据
     ================================================================ */
  const swanCache = {};
  /* 事件集变化时必须清空 —— 否则同一天早前缓存的「无扰动」结果会被复用 */
  function swanCacheClear() { for (const k in swanCache) delete swanCache[k]; }

  function swanRate() {
    if (!G.opt || !G.opt.blackswan) return 0;
    const lv = SWAN_LEVELS[G.opt.swanLevel | 0] || SWAN_LEVELS[3];
    return lv.rate;
  }

  /* 抽签: 每个交易日独立判定, 命中则按池子生成一条事件 */
  function rollSwan() {
    const rate = swanRate();
    if (rate <= 0) return null;
    const idx = Market.idx;
    if (idx - 1 < G.startIdx) return null;
    if (hash01((G.bSeed || '0') + '#swan?at' + idx) >= rate) return null;
    /* 不重复叠加同 id 的未结束事件 */
    const tpl = SWAN_POOL[Math.floor(hash01((G.bSeed || '0') + '#swpick' + idx) * SWAN_POOL.length) % SWAN_POOL.length];
    if (!tpl) return null;
    const running = G.swans.some(s => s.tpl === tpl.id && idx <= s.endIdx);
    if (running) return null;

    const ev = {
      id: 'sw' + (++G.swanSeq), tpl: tpl.id,
      name: tpl.name, kind: tpl.kind, t: tpl.t, tip: tpl.tip, face: tpl.face,
      scope: tpl.scope, target: '', drift: tpl.drift, days: tpl.days, vol: tpl.vol,
      startIdx: idx, endIdx: idx + tpl.days, day: Market.date()
    };
    if (tpl.scope === 'IND') {
      const inds = [];
      Market.tradable.forEach(m => {
        if (m.market !== 'main' && m.market !== 'gem' && m.market !== 'star') return;
        if (m.ind && inds.indexOf(m.ind) < 0) inds.push(m.ind);
      });
      inds.sort();
      if (!inds.length) return null;
      ev.target = inds[Math.floor(hash01((G.bSeed || '0') + '#swind' + idx) * inds.length) % inds.length];
      ev.name = ev.target + tpl.name;
      ev.t = ev.target + '：' + tpl.t;
    } else if (tpl.scope === 'FX') {
      const fx = Market.meta.filter(m => m.market === 'fx');
      if (!fx.length) return null;
      ev.target = fx[Math.floor(hash01((G.bSeed || '0') + '#swfx' + idx) * fx.length) % fx.length].code;
    }
    G.swans.push(ev);
    if (G.swans.length > 60) G.swans.shift();
    swanCacheClear();          // 新事件立即生效
    if (G.swanLog.length > 40) G.swanLog.length = 40;
    G.swanLog.unshift({
      id: ev.id, name: ev.name, kind: ev.kind, day: ev.day,
      drift: ev.drift, days: ev.days, target: ev.target, t: ev.t
    });
    if (ev.kind === 'bear' && !G.positions.length) award('swan_calm');
    log('黑天鹅', ev.target, ev.name,
      (ev.kind === 'bear' ? '利空' : '利好') + '冲击开始：' + ev.t +
      '（约 ' + ev.days + ' 个交易日）', ev.kind === 'bear' ? 'down' : 'up');
    award('swan_seen');
    emit('swan', ev);
    return ev;
  }

  function swanHits(s, code) {
    if (s.scope === 'ALL') return true;
    if (s.scope === 'IND') {
      const m = Market.metaOf(code);
      return !!(m && m.ind === s.target);
    }
    if (s.scope === 'FX') return code === s.target;
    return false;
  }

  /* 事件对各标的的累计乘子 (含确定性额外波动)
     注: 逆回购/银行理财走独立定价逻辑, 不参与权益类扰动 */
  function swanFactor(code, i) {
    if (!G.swans || !G.swans.length) return 1;
    if (!G.opt || !G.opt.blackswan) return 1;
    const mm = Market.metaOf(code);
    if (mm && (mm.market === 'rp' || mm.market === 'wm')) return 1;
    const ii = (i === undefined) ? Market.idx : i;
    const key = code + '@' + ii;
    const hit = swanCache[key];
    if (hit !== undefined) return hit;
    let k = 1;
    for (let n = 0; n < G.swans.length; n++) {
      const s = G.swans[n];
      if (!swanHits(s, code)) continue;
      const upto = Math.min(ii, s.endIdx);
      if (upto <= s.startIdx) continue;
      const span = upto - s.startIdx;
      k *= Math.pow(1 + s.drift, span);
      /* 额外波动: 确定性噪声, 但幅度被夹在漂移量之内 ——
         保证「利空事件净效果必为跌、利好事件净效果必为涨」, 方向不会被噪声盖掉 */
      let vol = 0;
      for (let d = s.startIdx + 1; d <= upto; d++) {
        vol += (hash01('swvol|' + s.id + '|' + code + '|' + d) - 0.5) * 2 * s.vol * 0.006;
      }
      const cap = Math.max(0.004, Math.abs(s.drift) * span * 0.6);
      vol = Math.max(-cap, Math.min(cap, vol));
      k *= (1 + vol);
    }
    k = Math.max(0.35, Math.min(2.8, k));
    swanCache[key] = k;
    return k;
  }

  /* 当日生效中的事件 */
  function activeSwans() {
    return G.swans.filter(s => Market.idx >= s.startIdx && Market.idx <= s.endIdx)
      .sort((a, b) => (b.startIdx - a.startIdx));
  }
  function swanSummary() {
    const a = activeSwans();
    if (!a.length) return null;
    let k = 1;
    a.forEach(s => { if (s.scope === 'ALL') k *= Math.pow(1 + s.drift, 1); });
    return { list: a, k };
  }

  /* ---- 影子价格: 真实价 × 蝴蝶扰动 × 黑天鹅扰动 × 微观结构扰动 ---- */
  /* 微观结构乘子(第三因子)。T02a 骨架阶段 Micro.factor 恒为 1 ⇒ 逐位回退 */
  function microFactor(code, i) {
    if (!window.Micro || typeof Micro.factor !== 'function') return 1;
    return Micro.factor(code, i);
  }
  function kAt(code, i) {
    return bfactorAt(code, i) * swanFactor(code, i) * microFactor(code, i);
  }
  function px(code, i) {
    const ii = (i === undefined) ? Market.idx : i;
    const k = kAt(code, ii);
    if (k === 1) return (ii === Market.idx) ? Market.price(code) : (Market.raw(code, ii) || { c: 0 }).c;
    const b = Market.raw(code, ii);
    return b ? b.c * k : Market.price(code) * k;
  }
  /* 影子口径的涨跌 —— 让玩家看到自己「实际面对」的行情 */
  function pxChg(code) {
    const idx = Market.idx;
    const now = px(code, idx);
    const prev = idx > 0 ? px(code, idx - 1) : 0;
    const pc = prev > 0 ? prev : Market.prevClose(code);
    return { abs: now - pc, pct: pc ? (now / pc - 1) * 100 : 0, now, pc };
  }
  function shadowed(code) { const k = kAt(code, Market.idx); return Math.abs(k - 1) > 1e-6; }

  /* ---- 设置 ---- */
  function setOpt(key, val) {
    if (!G.opt) G.opt = Object.assign({}, DEF_OPT);
    if (!(key in DEF_OPT)) return ok(false, '未知的设置项');
    G.opt[key] = val;
    if (key === 'butterfly' && !val) { G.butterfly = 0; G.bStart = {}; }
    if (key === 'blackswan' && !val) { G.swans = []; }
    if (key === 'swanLevel') { G.opt.swanLevel = Math.max(0, Math.min(4, val | 0)); }
    if (key === 'micro') { G.opt.micro = val !== false; }
    if (key === 'microLevel') { G.opt.microLevel = (val === 'lite' || val === 'hard') ? val : 'std'; }
    if (window.Micro && typeof Micro.setOpt === 'function') Micro.setOpt(key, G.opt[key]);
    clearButterflyCache();
    const label = { blackswan: '黑天鹅事件', butterfly: '蝴蝶效应', impact: '冲击成本', shortFee: '融券费', divTax: '红利税', news: '滚动快讯', swanNews: '事件播报', micro: '市场微观结构', microLevel: '微观结构档位' }[key] || key;
    const MLV = { lite: '简化', std: '标准', hard: '硬核' };
    const valTxt = (typeof val === 'boolean')
      ? (val ? '开启' : '关闭')
      : (key === 'swanLevel' ? ((SWAN_LEVELS[G.opt.swanLevel | 0] || {}).name || val)
        : (key === 'microLevel' ? (MLV[G.opt.microLevel] || String(val)) : String(val)));
    log('设置', '', '玩法开关', label + ' → ' + valTxt, 'warn');
    after();
    return ok(true, '设置已更新');
  }
  function optOf(key) {
    if (!G.opt) G.opt = Object.assign({}, DEF_OPT);
    return G.opt[key];
  }

  /* 后视镜审计: 开仓后 3 个交易日内朝有利方向明显偏离 -> 提升蝴蝶强度 */
  function auditHindsight() {
    const N = 3;
    G.positions.forEach(p => {
      if (!p.audit || Market.idx - p.auditIdx < N) return;
      p.audit = false;
      const r0 = Market.raw(p.code, p.auditIdx), r1 = Market.raw(p.code, p.auditIdx + N);
      if (!r0 || !r1 || r0.c <= 0 || p.auditIdx < G.startIdx) return;
      const fwd = (r1.c - r0.c) / r0.c;
      const fav = p.side === 'short' ? -fwd : fwd;
      G.auditN++;
      if (fav > 0.06) {
        G.hindsight++;
        G.butterfly = Math.min(1, G.butterfly + Math.min(0.25, 0.05 + fav * 0.6));
        G.bStart[p.code] = Market.idx;
        clearButterflyCache();
        const m = Market.metaOf(p.code);
        log('市场', p.code, m ? m.name : p.code,
          '走势与历史高度吻合…市场察觉到了「反身性」，对该标的施加扰动（蝴蝶强度 ' +
          (G.butterfly * 100).toFixed(0) + '%）', 'warn');
        emit('butterfly', { code: p.code, level: G.butterfly });
      }
    });
    if (G.hindsight >= 3) award('butterfly');
  }

  /* ================================================================
     理财类操作
     账务不变式: 现金买入 -> realized -= 成本 且 cashAssets += 成本
                 => equity 不变, avail 真实减少
     ================================================================ */

  /* ---------------- 国债逆回购 ---------------- */
  function rpFeeOf(amount, days) {
    let f = amount * (RP_FEE[days] || 0);
    if (days >= 91) f = Math.min(f, RP_FEE_CAP);
    return Math.max(0.01, f);
  }
  function buyRepo(code, amount) {
    const meta = Market.metaOf(code);
    if (!meta || meta.market !== 'rp') return ok(false, '未知的逆回购品种');
    const days = RP_DAYS[code];
    if (!days) return ok(false, '未知的期限品种');
    amount = Math.floor(amount);
    if (amount < REPO_MIN) return ok(false, '逆回购 ' + money(REPO_MIN) + ' 元起投');
    if (amount % REPO_MIN !== 0) return ok(false, '申报数量须为 ' + money(REPO_MIN) + ' 元的整数倍');
    const rate = Market.price(code);
    const fee = rpFeeOf(amount, days);
    if (amount + fee > avail() + 1e-6) return ok(false, '可用资金不足 (需 ' + money(amount + fee) + ')');
    G.realized -= amount + fee;
    G.repos.push({
      code, name: meta.name, amount, rate, days, fee,
      startIdx: Market.idx, matureIdx: Market.idx + days
    });
    award('repo_first');
    log('逆回购', code, meta.name, '出借 ' + money(amount) + ' @' + rate.toFixed(3) + '% / ' +
      days + ' 天（手续费 ' + money(fee) + '，不可提前赎回）', 'up');
    emit('repoBuy', { code, amount, days, rate });
    after();
    return ok(true, '已出借 ' + money(amount) + '，' + days + ' 天后自动回款');
  }
  function settleRepos() {
    for (let i = G.repos.length - 1; i >= 0; i--) {
      const r = G.repos[i];
      if (Market.idx >= r.matureIdx) {
        const interest = r.amount * (r.rate / 100) * (r.days / 365);
        G.realized += r.amount + interest;
        log('逆回购', r.code, r.name, '到期回款 本金 ' + money(r.amount) +
          ' 利息 +' + interest.toFixed(2) + ' 元', 'up');
        emit('repoMature', { name: r.name, interest });
        award('repo_matured');
        G.repos.splice(i, 1);
      }
    }
  }

  /* ---------------- 银行理财 (净值型) ---------------- */
  function wealthProduct(code) {
    const meta = Market.metaOf(code);
    if (!meta || meta.market !== 'wm') return null;
    const mm = meta.ind.match(/R\d/);
    const level = mm ? mm[0] : 'R2';
    return { code, name: meta.name, level, info: WM_LEVELS[level] || WM_LEVELS.R2 };
  }
  function buyWealth(code, amount) {
    const w = wealthProduct(code);
    if (!w) return ok(false, '未知的理财产品');
    amount = Math.floor(amount);
    if (amount < WM_MIN) return ok(false, '起购金额 ' + money(WM_MIN) + ' 元');
    const held = G.wealth.filter(x => x.code === code)
      .reduce((s, x) => s + x.shares * Market.price(x.code), 0);
    if (held + amount > w.info.cap + 1) {
      return ok(false, w.level + ' 单只持有上限 ' + money(w.info.cap));
    }
    if (amount > avail() + 1e-6) return ok(false, '可用资金不足 (需 ' + money(amount) + ')');
    const nav = Market.price(code);
    G.realized -= amount;
    const ex = G.wealth.find(x => x.code === code);
    if (ex) { ex.shares += amount / nav; ex.cost += amount; }
    else G.wealth.push({
      code, name: w.name, level: w.level,
      shares: amount / nav, cost: amount, nav0: nav, startIdx: Market.idx
    });
    award('wealth_first');
    if (w.level === 'R5') award('wealth_r5');
    log('理财', code, w.name, '申购 ' + money(amount) + ' @净值 ' + nav.toFixed(4), 'up');
    emit('wealthBuy', { code, amount });
    after();
    return ok(true, '已申购 ' + w.name + ' ' + money(amount));
  }
  function redeemWealth(code, amount) {
    const idx = G.wealth.findIndex(x => x.code === code);
    if (idx < 0) return ok(false, '未持有该理财产品');
    const w = G.wealth[idx];
    const nav = Market.price(code);
    const value = w.shares * nav;
    const amt = amount ? Math.min(Math.floor(amount), value) : value;
    if (amt <= 0) return ok(false, '赎回金额无效');
    const part = amt / value;
    const costPart = w.cost * part;
    const pnl = amt - costPart;
    G.realized += amt;
    w.shares -= w.shares * part;
    w.cost -= costPart;
    const full = part >= 0.9999 || w.shares * nav < 1;
    if (full) G.wealth.splice(idx, 1);
    log('理财', code, w.name, (full ? '赎回 ' : '部分赎回 ') + money(amt) +
      ' @净值 ' + nav.toFixed(4) + ' 盈亏' + (pnl >= 0 ? '+' : '') + money(pnl),
      pnl >= 0 ? 'up' : 'down');
    emit('wealthRedeem', { code, amount: amt, pnl });
    after();
    return ok(true, '已赎回 ' + money(amt) + '（盈亏 ' + (pnl >= 0 ? '+' : '') + money(pnl) + '）');
  }

  /* ---------------- 指数基金定投 ---------------- */
  function setDca(code, amount, every) {
    const meta = Market.metaOf(code);
    if (!meta || !meta.tradable) return ok(false, '该标的不可定投');
    if (meta.market !== 'fd') return ok(false, '定投计划仅支持场内基金（ETF / LOF）');
    amount = Math.floor(amount);
    if (amount < 100) return ok(false, '每期定投金额至少 100 元');
    every = Math.max(1, Math.min(60, Math.floor(every || 5)));
    const ex = G.dca.find(d => d.code === code);
    if (ex) { ex.amount = amount; ex.every = every; }
    else G.dca.push({
      code, name: meta.name, amount, every,
      lastIdx: Market.idx - every, count: 0, total: 0
    });
    award('dca_first');
    log('定投', code, meta.name, '设置每 ' + every + ' 个交易日定投 ' + money(amount) + ' 元', 'up');
    emit('dcaSet', { code, amount, every });
    after();
    return ok(true, '已设置 ' + meta.name + ' 每 ' + every + ' 日定投 ' + money(amount));
  }
  function cancelDca(code) {
    const i = G.dca.findIndex(d => d.code === code);
    if (i < 0) return ok(false, '未找到该定投计划');
    const d = G.dca[i];
    G.dca.splice(i, 1);
    log('定投', code, d.name, '已终止定投计划（累计投入 ' + money(d.total) + '，共 ' + d.count + ' 期）', 'warn');
    after();
    return ok(true, '已终止 ' + d.name + ' 的定投');
  }
  function runDca() {
    if (!G.dca.length) return;
    G.dca.slice().forEach(d => {
      if (Market.idx - d.lastIdx < d.every) return;
      const price = px(d.code);
      if (!price) return;
      const L = lot(d.code);
      const sh = Math.floor(d.amount / price / L) * L;
      if (sh < L) return;
      const amt = sh * price, fee = buyFee(amt, d.code);
      if (amt + fee > avail()) {
        log('定投', d.code, d.name, '可用资金不足，本期定投自动跳过', 'warn');
        return;
      }
      const p = pos(d.code);
      if (p && p.side !== 'long') return;
      d.lastIdx = Market.idx;
      G.realized -= amt + fee;
      if (p) {
        const total = p.shares + sh;
        p.cost = (p.cost * p.shares + amt + fee) / total;
        p.shares = total;
        p.lots = p.lots || []; p.lots.push({ shares: sh, idx: Market.idx });
        p.lastBuyIdx = Market.idx;
      } else {
        G.positions.push({
          code: d.code, shares: sh, cost: (amt + fee) / sh, side: 'long',
          openIdx: Market.idx, buyDays: [Market.date()], lastBuyIdx: Market.idx,
          lots: [{ shares: sh, idx: Market.idx }], divs: []
        });
      }
      G.totalBuys++; d.count++; d.total += amt + fee;
      log('定投', d.code, d.name, '第 ' + d.count + ' 期定投 ' + sh + ' 份 @' + price.toFixed(3), 'up');
    });
  }

  /* ---------------- 商业保险 ---------------- */
  function buyInsurance(pid) {
    const p = INSURANCE.find(x => x.id === pid);
    if (!p) return ok(false, '未知的保险产品');
    if (p.premium > avail() + 1e-6) return ok(false, '可用资金不足 (需 ' + money(p.premium) + ')');
    const cv = p.kind === '年金' ? p.premium * 0.55 : p.premium * 0.05;
    G.realized -= p.premium;
    G.insures.push({
      pid: p.id, name: p.name, icon: p.icon, kind: p.kind, premium: p.premium,
      startIdx: Market.idx, lastPayIdx: Market.idx, contributed: p.premium,
      benefits: 0, cashValue: cv
    });
    award('insure_first');
    log('保险', '', p.name, '投保成功，缴费 ' + money(p.premium) + '（首日现金价值仅 ' +
      money(cv) + '，早期退保损失大）', 'up');
    emit('insureBuy', { name: p.name });
    after();
    return ok(true, '已投保 ' + p.name);
  }
  function surrenderInsurance(i) {
    const ins = G.insures[i];
    if (!ins) return ok(false, '未找到该保单');
    const refund = ins.cashValue;
    const loss = Math.max(0, ins.contributed - ins.benefits - refund);
    G.realized += refund;
    G.insures.splice(i, 1);
    log('保险', '', ins.name, '退保，退回现金价值 ' + money(refund) +
      '，累计损失 ' + money(loss), 'warn');
    emit('insureSurrender', { name: ins.name, loss });
    after();
    return ok(true, '已退保，退回 ' + money(refund) + '（损失 ' + money(loss) + '）');
  }
  function accrueInsurance() {
    G.insures.forEach(ins => {
      const held = Math.max(0, Market.idx - ins.startIdx);
      if (ins.kind === '年金') {
        ins.cashValue = ins.premium * Math.min(1, 0.55 + 0.45 * (held / 1260));
        while (Market.idx - ins.lastPayIdx >= 252) {
          ins.lastPayIdx += 252;
          const pay = ins.premium * 0.035;
          G.realized += pay;
          ins.benefits += pay;
          log('保险', '', ins.name, '领取年金 +' + money(pay) + '（累计已领 ' +
            money(ins.benefits) + '）', 'up');
        }
      } else {
        ins.cashValue = ins.premium * 0.05;
      }
    });
  }

  /* ---------------- 个人养老金账户 ---------------- */
  function pensionContribute(amount) {
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入缴费金额');
    const P = G.pension;
    if (!P.winStart && P.winStart !== 0) P.winStart = Market.idx;
    if (Market.idx - P.winStart >= 252) { P.winStart = Market.idx; P.contributed = 0; }
    const remain = PENSION_CAP - P.contributed;
    if (remain <= 0) return ok(false, '本年度缴费额度已用完（上限 ' + money(PENSION_CAP) + ' 元/年）');
    amount = Math.min(amount, remain);
    if (amount > avail() + 1e-6) return ok(false, '可用资金不足 (需 ' + money(amount) + ')');
    G.realized -= amount;
    P.balance += amount;
    P.contributed += amount;
    const saved = amount * PENSION_TAX;
    G.realized += saved;
    P.taxSaved += saved;
    award('pension_first');
    log('养老金', '', '个人养老金', '缴费 ' + money(amount) + '，当期个税抵扣 +' + money(saved) +
      '（本年度剩余额度 ' + money(Math.max(0, remain - amount)) + '）', 'up');
    emit('pensionPay', { amount, saved });
    after();
    return ok(true, '已缴费 ' + money(amount) + '，个税抵扣 +' + money(saved));
  }
  function pensionWithdraw() {
    const P = G.pension;
    if (P.balance <= 0) return ok(false, '养老金账户余额为 0');
    const bal = P.balance, claw = P.taxSaved;
    G.realized += bal - claw;
    P.balance = 0; P.taxSaved = 0;
    log('养老金', '', '提前支取', '取出 ' + money(bal) + '，退回已享受的税优 ' + money(claw) +
      '（现实中个人养老金封闭运行，须符合法定情形才能领取）', 'warn');
    emit('pensionOut', { bal, claw });
    after();
    return ok(true, '已支取 ' + money(bal) + '（退回税优 ' + money(claw) + '）');
  }
  function accruePension(days) {
    if (G.pension.balance > 0) {
      G.pension.balance *= Math.pow(1 + PENSION_RATE / 252, days || 1);
    }
  }

  /* ---------------- 可转债打新 (信用申购) ---------------- */
  function cbBanned() { return Market.idx < G.cbBanUntil; }
  function cbApply(lots) {
    if (cbBanned()) {
      return ok(false, '弃购满 ' + CB_FORFEIT_MAX + ' 次，还有 ' +
        (G.cbBanUntil - Market.idx) + ' 个交易日不得申购');
    }
    lots = Math.floor(lots || 1);
    if (lots < 1 || lots > 100) return ok(false, '申购数量为 1~100 手（1 手 = 10 张 = 1,000 元面额）');
    if (G.cbApplies.length >= 5) return ok(false, '同时最多挂 5 笔申购');
    G.cbApplies.push({
      id: 'cb' + Market.idx + '_' + G.cbApplies.length + '_' + lots,
      lots, idx: Market.idx, day: Market.date()
    });
    log('打新', '', '可转债申购', '信用申购 ' + lots + ' 手（零成本，中签后缴款 ' +
      money(lots * CB_LOT * CB_FV) + '）', 'up');
    emit('cbApply', { lots });
    after();
    return ok(true, '已申购 ' + lots + ' 手，等待中签结果');
  }
  function cbResolve() {
    if (!G.cbApplies.length) return;
    for (let i = G.cbApplies.length - 1; i >= 0; i--) {
      const a = G.cbApplies[i];
      if (Market.idx <= a.idx) continue;
      G.cbApplies.splice(i, 1);
      /* 中签结果绑定「本局种子 + 申购序号」: 同一存档可复现, 不同开局互相独立 */
      const tick = (G.bSeed || '0') + '#' + a.id + '#' + a.idx + '#' + i;
      const r = hash01(tick + '#win');
      const win = r < 0.40 ? Math.max(1, Math.round(a.lots * (0.03 + r * 0.15))) : 0;
      if (win <= 0) {
        log('打新', '', '未中签', '申购 ' + a.lots + ' 手，本次未中签', 'down');
        continue;
      }
      const need = win * CB_LOT * CB_FV;
      if (need > avail() + 1e-6) {
        G.cbForfeit++;
        log('打新', '', '放弃认购', '中签 ' + win + ' 手需缴款 ' + money(need) +
          '，资金不足只能放弃（第 ' + G.cbForfeit + ' 次）', 'warn');
        if (G.cbForfeit >= CB_FORFEIT_MAX && !cbBanned()) {
          G.cbBanUntil = Market.idx + CB_BAN_DAYS;
          log('打新', '', '申购禁令', '12 个月内弃购满 ' + CB_FORFEIT_MAX +
            ' 次，6 个月内不得参与新股/可转债/可交换债申购', 'warn');
          award('cb_forfeit');
        }
        emit('cbForfeit', { count: G.cbForfeit });
        continue;
      }
      G.realized -= need;
      award('cb_allot');
      /* 上市首日一次性结算: 在真实首日涨跌幅区间内确定性取样, 多数不破发 */
      const rr = (hash01(tick + '#ipo1') + hash01(tick + '#ipo2')) / 2;
      const up = CB_FIRST_UP / 100, down = -CB_FIRST_DOWN / 100;
      const ret = down + (up - down) * Math.pow(rr, 0.55);
      const pnl = need * ret;
      G.realized += need + pnl;
      G.cbWins.push({ lots: win, ret: ret * 100, pnl, day: Market.date() });
      log('打新', '', '首日了结', '中签 ' + win + ' 手（缴款 ' + money(need) + '）上市首日 ' +
        (ret >= 0 ? '+' : '') + (ret * 100).toFixed(1) + '%，盈亏 ' +
        (pnl >= 0 ? '+' : '') + money(pnl), ret >= 0 ? 'up' : 'down');
      if (ret >= 0) award('cb_ipo'); else award('cb_break');
      emit('cbIpo', { ret, pnl });
    }
  }

  /* ---------------- 分红除权 & 红利税 ---------------- */
  /* 持股期限 -> 红利税实际税负 (财税〔2015〕101号 / 财税〔2012〕85号)
     ≤1个月 20% · 1个月~1年 10% · >1年 免征 */
  function divTaxRate(holdingDays) {
    if (holdingDays <= 30) return 0.20;
    if (holdingDays <= 365) return 0.10;
    return 0;
  }
  function settleDividends() {
    const today = Market.dividendsOn();
    if (!today.length) return;
    G.positions.forEach(p => {
      if (p.side === 'short') return;                 // 空头不享有分红
      today.forEach(e => {
        if (e.c !== p.code) return;
        const cash = p.shares * e.s;
        if (cash <= 0) return;
        G.realized += cash;
        G.divTotal += cash;
        p.divs = p.divs || [];
        p.divs.push({ idx: Market.idx, perShare: e.s });
        const meta = Market.metaOf(p.code);
        G.divLog.unshift({
          code: p.code, name: meta ? meta.name : p.code, cash,
          perShare: e.s, day: Market.date()
        });
        if (G.divLog.length > 60) G.divLog.length = 60;
        log('分红', p.code, meta ? meta.name : p.code,
          '除权除息派现 ' + money(cash) + '（每股 ' + e.s.toFixed(4) +
          ' 元）· 持股≤1年暂不预扣，卖出时按期限补缴', 'up');
        emit('dividend', { code: p.code, cash });
        award('div_first');
      });
    });
  }
  /* 卖出时按「先进先出」逐 lot 计算应补缴的红利税 */
  function dividendTaxFIFO(p, sellShares) {
    if (G.opt && G.opt.divTax === false) return 0;
    if (!p.divs || !p.divs.length) return 0;
    if (!p.lots || !p.lots.length) {
      p.lots = [{ shares: p.shares, idx: p.openIdx || 0 }];
    }
    let remain = sellShares, tax = 0;
    for (const l of p.lots) {
      if (remain <= 0) break;
      const take = Math.min(l.shares, remain);
      remain -= take;
      let per = 0;
      p.divs.forEach(d => { if (d.idx > l.idx) per += d.perShare; });
      if (per <= 0) continue;
      const days = Math.round((Market.idx - l.idx) * 365 / 252);   // 交易日 -> 自然日
      const rate = divTaxRate(days);
      tax += take * per * rate;
      if (rate === 0) award('div_1y');
    }
    return tax;
  }
  /* 卖出/平仓后同步扣减 lots (先进先出) */
  function consumeLots(p, shares) {
    if (!p.lots || !p.lots.length) return;
    let remain = shares;
    while (remain > 0 && p.lots.length) {
      const l = p.lots[0];
      const take = Math.min(l.shares, remain);
      l.shares -= take;
      remain -= take;
      if (l.shares <= 0) p.lots.shift();
    }
  }

  /* ---------------- 非正规借贷: 高利贷 / 复利贷 / 网贷 (普法演示) ---------------- */
  function illProduct(pid) { return ILLEGAL_LOANS.find(p => p.id === pid); }

  function borrowIllegal(pid, amount) {
    const p = illProduct(pid);
    if (!p) return ok(false, '未知的借贷产品');
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入借款金额');
    if (amount > 500000) return ok(false, '单笔民间借贷最多 50 万（模拟上限）');
    const cut = amount * p.cut;
    const net = amount - cut;
    G.realized += net;                 // 实际到手 (砍头息先扣)
    G.illLoans.push({
      id: pid, name: p.name, icon: p.icon, principal: amount,
      owed: amount, daily: p.daily, compound: p.compound,
      startDay: Market.idx, term: p.term, overdue: false
    });
    G.addic = Math.min(100, G.addic + 4);
    updateCredit(-8);
    log('借贷', '', p.name, '名义借 ' + money(amount) + '，砍头息扣 ' + money(cut) +
      '，实际到手 ' + money(net), 'warn');
    award('first_ill');
    emit('illBorrow', { product: p });
    after();
    return ok(true, '到手 ' + money(net) + '（砍头息 ' + money(cut) + '，欠条 ' + money(amount) + '）');
  }

  function repayIllegal(index, amount) {
    const l = G.illLoans[index];
    if (!l) return ok(false, '未找到该笔借款');
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入还款金额');
    const pay = Math.min(amount, l.owed, Math.max(0, avail()));
    if (pay <= 0) return ok(false, '可用资金不足，先卖出持仓筹钱吧');
    G.realized -= pay;
    l.owed = Math.max(0, l.owed - pay);
    const cleared = l.owed <= 0.5;
    if (cleared) G.illLoans.splice(index, 1);
    log('借贷', '', '还款', '偿还 ' + l.name + ' ' + money(pay) + (cleared ? ' · 已结清' : ''), 'down');
    if (!G.illLoans.length) { G.illStage = 0; updateCredit(6); award('ill_cleared'); }
    after();
    return ok(true, (cleared ? '已结清 ' : '已还款 ') + money(pay));
  }

  function accrueIllegal(days) {
    days = days || 1;
    G.illLoans.forEach(l => {
      if (l.compound) l.owed = l.owed * Math.pow(1 + l.daily, days);
      else l.owed = l.owed * (1 + l.daily * days);
      if (l.term > 0 && (Market.idx - l.startDay) > l.term) l.overdue = true;
    });
  }

  /* 催收: 逾期 / 金额升级 → 短信轰炸 → 爆通讯录 → 上门 & 强制处置财产 */
  function checkCollect() {
    if (!G.illLoans.length) return;
    const anyOverdue = G.illLoans.some(l => l.overdue);
    const total = illTotal();
    let stage = 0;
    if (anyOverdue || total > G.base * 0.5) stage = 1;
    if (anyOverdue && total > G.base * 1.2) stage = 2;
    if (total > G.base * 3) stage = 3;
    if (stage <= G.illStage) return;
    G.illStage = stage;
    G.illCollected++;
    updateCredit(-15 * stage);
    if (stage === 1) {
      log('催收', '', '威胁', '【短信轰炸】“欠债还钱天经地义”——一天几十条催收短信涌进来', 'warn');
    } else if (stage === 2) {
      log('催收', '', '爆通讯录', '【爆通讯录】催收电话打给你所有亲友、同事、领导，社会性死亡', 'warn');
    } else if (stage === 3) {
      log('催收', '', '上门', '【上门/暴力催收】对方上门堵人、限制人身自由——这已涉嫌犯罪', 'warn');
      let short = illTotal();
      G.assets.forEach(a => {
        if (short > 0 && a.value - a.mort > 0) {
          const take = Math.min(a.value - a.mort, short);
          a.mort += take; short -= take;
          log('催收', '', '处置资产', a.icon + a.name + ' 被强制处置抵债 ' + money(take), 'warn');
        }
      });
      if (short > 0) {
        G.illLoans = [];
        G.ruin = true; G.dead = true;
        award('gameover');
        emit('ruin', { viaIll: true });
      }
    }
    emit('collect', { stage });
  }

  /* ---------------- 持牌消费信贷 & 亲友借贷 ---------------- */
  function civProduct(pid) {
    return CONSUMER_CREDIT.find(p => p.id === pid) || FRIEND_LOANS.find(p => p.id === pid) || null;
  }
  function borrowCivil(pid, amount) {
    const p = civProduct(pid);
    if (!p) return ok(false, '未知的借款产品');
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入借款金额');
    if (amount > p.limit) return ok(false, p.name + ' 单笔最多 ' + money(p.limit));
    const isFriend = FRIEND_LOANS.indexOf(p) >= 0;
    if (isFriend) {
      if (G.relation <= 0) return ok(false, '亲友已不愿再借钱给你（人情耗尽）。先把欠的还上吧。');
      if (G.relation < 20) return ok(false, '人情所剩无几（' + Math.round(G.relation) + '），没人愿意再借了。');
    }
    const cut = amount * p.cut;
    const net = amount - cut;
    G.realized += net;
    G.civLoans.push({
      kind: isFriend ? 'friend' : 'consumer', id: pid, name: p.name, icon: p.icon,
      principal: amount, owed: amount, daily: p.daily, compound: !!p.compound,
      term: p.term || 0, trust: p.trust || 0, startDay: Market.idx,
      overdue: false, penalized: false
    });
    if (isFriend) { G.relation = Math.max(0, G.relation - 2); award('first_friend'); }
    else { updateCredit(-2); award('first_credit'); }
    log('借贷', '', p.name,
      (isFriend ? '开口借到 ' : '借入 ') + money(amount) + (cut > 0 ? '（手续费 ' + money(cut) + '）' : ''),
      isFriend ? 'warn' : 'up');
    emit('civBorrow', { product: p });
    after();
    return ok(true, '到手 ' + money(net) + (cut > 0 ? '（手续费 ' + money(cut) + '，欠 ' + money(amount) + '）' : ''));
  }
  function repayCivil(index, amount) {
    const l = G.civLoans[index];
    if (!l) return ok(false, '未找到该笔借款');
    amount = Math.floor(amount);
    if (amount <= 0) return ok(false, '请输入还款金额');
    const pay = Math.min(amount, l.owed, Math.max(0, avail()));
    if (pay <= 0) return ok(false, '可用资金不足，先卖出持仓筹钱吧');
    G.realized -= pay;
    l.owed = Math.max(0, l.owed - pay);
    const cleared = l.owed <= 0.5;
    if (cleared) G.civLoans.splice(index, 1);
    if (cleared) {
      if (l.kind === 'friend') {
        if (!l.overdue) G.relation = Math.min(100, G.relation + l.trust);
        award('friend_paid');
        log('借贷', '', '有借有还', '还清 ' + l.name + ' ' + money(pay) +
          (l.overdue ? '（曾逾期，人情未回补）' : '，人情 +' + l.trust), 'down');
      } else {
        updateCredit(2);
        log('借贷', '', '还款', '结清 ' + l.name + ' ' + money(pay), 'down');
      }
    } else {
      log('借贷', '', '还款', '偿还 ' + l.name + ' ' + money(pay), 'down');
    }
    after();
    return ok(true, (cleared ? '已结清 ' : '已还款 ') + money(pay));
  }
  function accrueCivil(days) {
    days = days || 1;
    G.civLoans.forEach(l => {
      if (l.kind === 'friend') {
        if (l.term > 0 && (Market.idx - l.startDay) > l.term) l.overdue = true;
        return;
      }
      if (l.compound) l.owed = l.owed * Math.pow(1 + l.daily, days);
      else l.owed = l.owed * (1 + l.daily * days);
      if (l.term > 0 && (Market.idx - l.startDay) > l.term) l.overdue = true;
    });
  }
  /* 消费信贷逾期 → 征信受损; 亲友借款逾期 → 人情受损 */
  function checkCivil() {
    if (!G.civLoans.length) { G.relationWarned = false; return; }
    G.civLoans.forEach(l => {
      if (!l.overdue || l.penalized) return;
      l.penalized = true;
      if (l.kind === 'consumer') {
        updateCredit(-20);
        log('征信', '', '逾期', l.name + ' 逾期未还，征信记录受损（信用分 -20）', 'warn');
        emit('civOverdue', { kind: 'consumer', name: l.name });
      } else {
        G.relation = Math.max(0, G.relation - l.trust);
        log('人情', '', '催还', '借了「' + l.name + '」的钱逾期未还，对方在群里 @ 了你（人情 -' + l.trust + '）', 'warn');
        emit('civOverdue', { kind: 'friend', name: l.name });
        if (G.relation <= 0 && !G.relationWarned) {
          G.relationWarned = true;
          log('人情', '', '众叛亲离', '该还的都没还，亲友圈已经没人愿意理你了。', 'warn');
          award('relation_bad');
        }
      }
    });
  }

  function checkTday() {
    if (G.mode === 'live') return;
  }

  function after() {
    snapshotHistory();
    check();
    save();
    emit('change', {});
  }

  /* ---------------- 成就 ---------------- */
  const BADGES = [
    { id: 'first_trade', name: '第一手' },
    { id: 'first_limit', name: '抓到涨停' },
    { id: 'first_limit_down', name: '吃到跌停' },
    { id: 'big_win', name: '单笔+30%' },
    { id: 'diversified', name: '撒网5只' },
    { id: 'high_roller', name: '十倍赌徒' },
    { id: 'margin_call', name: '追加保证金' },
    { id: 'blown', name: '被强平过' },
    { id: 'gameover', name: '退 場' },
    { id: 'patient', name: '拿满60天' },
    { id: 'double', name: '资金翻倍' },
    { id: 'addicted', name: '中毒100%' },
    { id: 'first_short', name: '初次做空' },
    { id: 'short_win', name: '空头和了' },
    { id: 'first_loan', name: '融资初体验' },
    { id: 'first_mort', name: '抵押借款' },
    { id: 'loan_blown', name: '质押爆仓' },
    { id: 'credit_bad', name: '失信名单' },
    { id: 'first_ill', name: '借了高利贷' },
    { id: 'ill_cleared', name: '上岸成功' },
    { id: 'first_credit', name: '用上花呗' },
    { id: 'first_friend', name: '开口借钱' },
    { id: 'friend_paid', name: '有借有还' },
    { id: 'relation_bad', name: '众叛亲离' },
    /* ---- 理财类 ---- */
    { id: 'repo_first', name: '逆回购初体验' },
    { id: 'repo_matured', name: '到期回款' },
    { id: 'wealth_first', name: '理财入门' },
    { id: 'wealth_r5', name: '买过 R5' },
    { id: 'dca_first', name: '开始定投' },
    { id: 'insure_first', name: '第一张保单' },
    { id: 'pension_first', name: '个人养老金' },
    { id: 'cb_first', name: '可转债 T+0' },
    { id: 'cb_allot', name: '打新中签' },
    { id: 'cb_ipo', name: '打新吃肉' },
    { id: 'cb_break', name: '打新破发' },
    { id: 'cb_forfeit', name: '弃购被禁' },
    { id: 'div_first', name: '第一次拿分红' },
    { id: 'div_1y', name: '长持免税' },
    /* ---- 反作用力 ---- */
    { id: 'butterfly', name: '被市场反噬' },
    { id: 'shock', name: '掀起波澜' },
    /* ---- 黑天鹅 ---- */
    { id: 'swan_seen', name: '亲历黑天鹅' },
    { id: 'swan_calm', name: '风暴中空仓' },
    { id: 'swan_ride', name: '危机抄底' }
  ];
  function award(id) {
    if (G.badges[id]) return;
    G.badges[id] = 1;
    const b = BADGES.find(x => x.id === id);
    if (b) { log('成就', '', '解锁', b.name, 'achv'); emit('badge', { name: b.name }); }
  }
  function checkBadges() {
    if (equity() >= G.base * 2) award('double');
    if (G.addic >= 99.5) award('addicted');
    G.positions.forEach(p => {
      if (Market.idx - p.openIdx >= 60) award('patient');
    });
  }

  /* ---------------- 日志 ---------------- */
  function log(kind, code, name, text, cls) {
    G.log.unshift({ kind, code, name, text, cls, day: Market.date(), t: Date.now() });
    if (G.log.length > 160) G.log.length = 160;
  }
  function clearLog() { G.log = []; save(); emit('change', {}); }

  function money(n) {
    const s = Math.abs(n) >= 10000 ? (n / 10000).toFixed(2) + '万' : n.toFixed(0);
    return (n >= 0 ? '' : '-') + s.replace('-', '');
  }
  function ok(v, msg, cls) { return { ok: v, msg, cls: cls || (v ? 'ok' : 'bad') }; }

  /* ---------------- 杠杆 ---------------- */
  function setLeverage(v) {
    const old = G.leverage;
    G.leverage = v;
    if (v > old) {
      G.addic = Math.min(100, G.addic + (v - old) * 1.6);
      emit('leverUp', { v });
    } else emit('leverDown', { v });
    check(); after();
  }

  /* ---------------- 存档 ---------------- */
  /* 微观 carry 清洗：只保留 { code: [[idx, carry], …] } 结构，剔除非法值，杜绝 NaN */
  function sanitizeCarry(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(code => {
      const src = raw[code];
      if (!Array.isArray(src)) return;
      const arr = [];
      src.forEach(pt => {
        if (!Array.isArray(pt) || pt.length < 2) return;
        const idx = pt[0], c = pt[1];
        if (Number.isFinite(idx) && Number.isFinite(c)) arr.push([idx, c]);
      });
      if (arr.length) out[code] = arr;
    });
    return out;
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        base: G.base, realized: G.realized, leverage: G.leverage, mode: G.mode,
        positions: G.positions, history: G.history, startIdx: G.startIdx,
        addic: G.addic, badges: G.badges, margins: G.margins, ruin: G.ruin,
        dead: G.dead, peakEquity: G.peakEquity, maxDrawdown: G.maxDrawdown,
        wins: G.wins, losses: G.losses, totalBuys: G.totalBuys, totalSells: G.totalSells,
        trades: G.trades.slice(-120), log: G.log.slice(0, 60),
        debt: G.debt, debtInterest: G.debtInterest, cashFund: G.cashFund,
        credit: G.credit, assets: G.assets,
        illLoans: G.illLoans, illStage: G.illStage, illCollected: G.illCollected,
        civLoans: G.civLoans, relation: G.relation,
        /* ---- 理财 / 可转债 / 分红 / 反作用力 ---- */
        repos: G.repos, wealth: G.wealth, dca: G.dca, insures: G.insures,
        pension: G.pension,
        cbApplies: G.cbApplies, cbForfeit: G.cbForfeit, cbBanUntil: G.cbBanUntil,
        cbWins: G.cbWins.slice(0, 30),
        divTotal: G.divTotal, divTax: G.divTax, divLog: G.divLog.slice(0, 40),
        impact: G.impact, impactLog: G.impactLog.slice(0, 20), shortFee: G.shortFee,
        butterfly: G.butterfly, hindsight: G.hindsight,
        bSeed: G.bSeed, bStart: G.bStart,
        microCarry: G.microCarry,
        /* ---- 黑天鹅 / 玩法开关 ---- */
        swans: G.swans, swanLog: G.swanLog.slice(0, 24), swanSeq: G.swanSeq,
        opt: G.opt,
        idx: Market.idx, utime: Date.now()
      }));
    } catch (e) { }
  }
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function hasSave() { return !!loadSave(); }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { } }

  function restore(sv) {
    if (!sv) return false;
    G.base = sv.base; G.realized = sv.realized; G.leverage = sv.leverage;
    G.positions = (sv.positions || []).map(p => Object.assign({ side: 'long' }, p));
    G.history = sv.history || [];
    G.startIdx = sv.startIdx; G.addic = sv.addic || 0; G.badges = sv.badges || {};
    G.margins = sv.margins || 0; G.ruin = !!sv.ruin; G.dead = !!sv.dead;
    G.peakEquity = sv.peakEquity || sv.base; G.maxDrawdown = sv.maxDrawdown || 0;
    G.wins = sv.wins || 0; G.losses = sv.losses || 0;
    G.totalBuys = sv.totalBuys || 0; G.totalSells = sv.totalSells || 0;
    G.trades = sv.trades || []; G.log = sv.log || [];
    G.mode = sv.mode || 'replay';
    G.debt = sv.debt || 0; G.debtInterest = sv.debtInterest || 0;
    G.cashFund = !!sv.cashFund; G.loanWarned = false; G._recorded = false;
    G.credit = (sv.credit !== undefined) ? sv.credit : CREDIT_START;
    G.assets = sv.assets || defaultAssets();
    G.illLoans = sv.illLoans || []; G.illStage = sv.illStage || 0;
    G.illCollected = sv.illCollected || 0;
    G.civLoans = sv.civLoans || [];
    G.relation = (sv.relation !== undefined) ? sv.relation : 100;
    G.relationWarned = false;
    /* ---- 理财 / 可转债 / 分红 / 反作用力 (旧存档缺失时全部兜底) ---- */
    G.repos = sv.repos || [];
    G.wealth = sv.wealth || [];
    G.dca = sv.dca || [];
    G.insures = sv.insures || [];
    G.pension = sv.pension || { contributed: 0, balance: 0, year: 0, taxSaved: 0, winStart: 0 };
    if (G.pension.winStart === undefined) G.pension.winStart = 0;
    G.cbApplies = sv.cbApplies || [];
    G.cbForfeit = sv.cbForfeit || 0;
    G.cbBanUntil = (sv.cbBanUntil !== undefined) ? sv.cbBanUntil : -1;
    G.cbWins = sv.cbWins || [];
    G.divTotal = sv.divTotal || 0;
    G.divTax = sv.divTax || 0;
    G.divLog = sv.divLog || [];
    G.impact = sv.impact || {};
    G.impactLog = sv.impactLog || [];
    G.shortFee = sv.shortFee || 0;
    G.butterfly = sv.butterfly || 0;
    G.hindsight = sv.hindsight || 0;
    G.bSeed = sv.bSeed || ('b' + Math.floor(Math.random() * 1e9));
    G.bStart = sv.bStart || {};
    /* 微观结构 carry：玩家冲击累积量（旧存档缺失时兜底空对象，杜绝 undefined/NaN） */
    G.microCarry = sanitizeCarry(sv.microCarry);
    /* ---- 黑天鹅 / 玩法开关 (旧存档逐项兜底, 默认全开) ---- */
    G.swans = sv.swans || [];
    G.swanLog = sv.swanLog || [];
    G.swanSeq = sv.swanSeq || G.swans.length;
    G.opt = Object.assign({}, DEF_OPT, sv.opt || {});
    G.opt.blackswan = G.opt.blackswan !== false;
    G.opt.swanLevel = G.opt.swanLevel === undefined ? 3 : G.opt.swanLevel;
    /* 新增玩法开关兜底: 旧存档缺少 micro/microLevel 时回落默认值 (否则 kAt 会变 NaN) */
    for (const _ok in DEF_OPT) { if (G.opt[_ok] === undefined) G.opt[_ok] = DEF_OPT[_ok]; }
    G.opt.micro = G.opt.micro !== false;
    G.opt.microLevel = (G.opt.microLevel === 'lite' || G.opt.microLevel === 'hard') ? G.opt.microLevel : 'std';
    /* 旧存档迁移: 回填持仓的 lots / divs (先进先出与红利税依赖它) */
    G.positions.forEach(p => {
      if (!p.lots || !p.lots.length) p.lots = [{ shares: p.shares, idx: p.openIdx || 0 }];
      if (!p.divs) p.divs = [];
    });
    clearButterflyCache();
    if (sv.idx !== undefined) Market.setIdx(sv.idx);
    return true;
  }

  function reset(mode, leverage, startIdx, opt) {
    opt = opt || {};
    G.base = BASE; G.realized = 0; G.leverage = leverage || 1;
    G.positions = []; G.trades = []; G.log = []; G.history = [];
    G.addic = 0; G.badges = {}; G.margins = 0; G.ruin = false; G.dead = false;
    G.peakEquity = BASE; G.maxDrawdown = 0; G.wins = 0; G.losses = 0;
    G.totalBuys = 0; G.totalSells = 0; G.warned = false; G.dayTrades = 0;
    G.debt = 0; G.debtInterest = 0; G.cashFund = false; G.loanWarned = false; G._recorded = false;
    G.credit = CREDIT_START; G.assets = defaultAssets();
    G.illLoans = []; G.illStage = 0; G.illCollected = 0;
    G.civLoans = []; G.relation = 100; G.relationWarned = false;
    /* ---- 理财 / 可转债 / 分红 / 反作用力 ---- */
    G.repos = []; G.wealth = []; G.dca = []; G.insures = [];
    G.pension = { contributed: 0, balance: 0, year: 0, taxSaved: 0, winStart: Market.idx };
    G.cbApplies = []; G.cbForfeit = 0; G.cbBanUntil = -1; G.cbWins = [];
    G.divTotal = 0; G.divTax = 0; G.divLog = [];
    G.impact = {}; G.impactLog = []; G.shortFee = 0;
    G.butterfly = 0; G.hindsight = 0; G.auditN = 0;
    G.bSeed = 'b' + Math.floor(Math.random() * 1e9);
    G.bStart = {};
    G.microCarry = {};                       // 新局：清空玩家微观冲击累积
    if (window.Micro && typeof Micro.reset === 'function') Micro.reset(G.bSeed);
    /* 玩法开关默认全开 (opt.opt 可覆盖, 例如开局前在设置里关掉某些机制) */
    G.swans = []; G.swanLog = []; G.swanSeq = 0;
    G.opt = Object.assign({}, DEF_OPT, (opt && opt.opt) || {});
    clearButterflyCache();
    G.mode = mode || 'replay';
    Market.setIdx(startIdx);
    Market.S.mode = mode;
    G.startIdx = startIdx;
    G.t0 = !!opt.t0;
    snapshotHistory();
    save();
  }

  /* ---------------- 排行榜 (localStorage + 对手) ---------------- */
  function recordRun(name) {
    try {
      const s = summary();
      const entry = {
        name: (name || '你').slice(0, 12), ret: +(s.returnPct).toFixed(2),
        equity: Math.round(s.equity), mode: G.mode, lev: G.leverage,
        zone: (G.positions[0] && Market.meta.find(m => m.code === G.positions[0].code) || {}).zone || 'A',
        days: (Market.idx - G.startIdx + 1), date: new Date().toISOString().slice(0, 10)
      };
      const raw = localStorage.getItem(LB_KEY);
      let arr = raw ? JSON.parse(raw) : [];
      arr.push(entry);
      arr.sort((a, b) => b.ret - a.ret);
      arr = arr.slice(0, 50);
      localStorage.setItem(LB_KEY, JSON.stringify(arr));
      return entry;
    } catch (e) { return null; }
  }
  function getLeaderboard() {
    try { return JSON.parse(localStorage.getItem(LB_KEY) || '[]'); } catch (e) { return []; }
  }
  function clearLeaderboard() { try { localStorage.removeItem(LB_KEY); } catch (e) { } }

  function on(fn) { G.listeners.push(fn); }

  return {
    G, buy, sell, closeAll, stepDay, summary, setLeverage, reset, restore,
    save, loadSave, hasSave, clearSave, save_key: SAVE_KEY,
    pos, canSellShares, sellable, limits, on, log, clearLog, award, checkBadges, check,
    buyFee, sellFee, marketValue, unrealized, equity, avail, marginRatio, usedMargin,
    loanAvail, debtTotal, pledge, repay, setCashFund, recordRun, getLeaderboard, clearLeaderboard,
    mortgage, redeem, mortAvail, creditBlocked, updateCredit, illTotal,
    borrowIllegal, repayIllegal,
    borrowCivil, repayCivil, civTotal, totalDebt, lot,
    money, emit, BASE, BADGES, LOAN_RATE, FUND_RATE,
    MORT_RATE, MORT_LTV, CREDIT_START, CREDIT_BAD, LEGAL_TIPS, ILLEGAL_LOANS,
    CONSUMER_CREDIT, FRIEND_LOANS,
    /* ---------- 理财类 ---------- */
    repoValue, wealthValue, pensionBal, insuranceCV, cashAssets,
    buyRepo, settleRepos, rpFeeOf,
    wealthProduct, buyWealth, redeemWealth,
    setDca, cancelDca, runDca,
    buyInsurance, surrenderInsurance,
    pensionContribute, pensionWithdraw,
    REPO_MIN, RP_FEE, RP_DAYS, WM_MIN, WM_LEVELS, INSURANCE,
    PENSION_CAP, PENSION_TAX,
    /* ---------- 可转债 ---------- */
    cbApply, cbResolve, cbBanned,
    CB_LOT, CB_FV, CB_FEE_RATE, CB_FIRST_UP, CB_FIRST_DOWN, CB_FORFEIT_MAX, CB_BAN_DAYS,
    /* ---------- 分红除权 ---------- */
    settleDividends, dividendTaxFIFO, divTaxRate, consumeLots,
    /* ---------- 操作反作用力 ---------- */
    impactSlip, fillPrice, px, pxChg, shadowed, kAt, microFactor, bfactor, bfactorAt,
    auditHindsight, hash01, SHORT_FEE_RATE,
    /* ---------- 黑天鹅 / 玩法开关 ---------- */
    rollSwan, activeSwans, swanSummary, swanFactor, setOpt, optOf,
    SWAN_LEVELS, SWAN_POOL, DEF_OPT
  };
})();
