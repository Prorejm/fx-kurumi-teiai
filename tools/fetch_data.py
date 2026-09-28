# -*- coding: utf-8 -*-
"""
抓取真实历史行情，生成前端可直接 <script> 加载的紧凑数据快照。

合规公开数据源 (均为公开、无需 key 的行情接口, 三级容错):
  1) 腾讯财经  ifzq.gtimg.cn          覆盖 A股/港股/ETF/债券/逆回购/可转债/指数
  2) 东方财富  push2his.eastmoney.com  覆盖最广, 含真实美股; 限流严格, 需强节流
  3) 新浪财经  money.finance.sina.com.cn  覆盖 A股/可转债/逆回购/ETF/商品/指数
  4) 新浪期货  stock.finance.sina.com.cn  InnerFuturesNewService 主力连续日线 (JSONP)
               已实测禁区: 腾讯不支持期货(nf_* 等 11 种形态全灭, 返回 v_pv_none_match)
  5) 数字资产  data-api.binance.vision  日线/实时 (CORS `*`, 运行期可直连)
               已实测禁区: api.binance.com 及 api1/2/3 全系不通, 勿换回
               备用: api.gateio.ws (字段顺序与直觉相反, 见 src_gateio 注释)

独立日期轴 (T03): 期货按各自交易日历、加密 7x24 按 UTC 00:00 收线,
均不并入 all_dates 主日历; 落盘时按「区间聚合」重采样, 避免周末行情被
当成停牌前向填充而丢失。主日历本身保持不变。

输出: <项目根>/data/snapshot.js
"""
import datetime
import html
import json
import os
import random
import re
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

DAYS = 520
MIN_ROWS = 30          # 少于该行数视为抓取失败
STALE_TOL = 8          # 末个交易日早于全局末日前 N 个交易日 -> 视为退市/强赎, 剔除

# ---- T03 另类品种: 独立日期轴 ----
FU_DAYS = 640          # 期货主力连续: 主日历 520 交易日 ~= 2 年, 期货日历取 640 根兜底
CR_DAYS = 1000         # 数字资产 7x24: 2 年 ~= 730 个 UTC 日, 取接口上限 1000 后按窗口裁切
ROLL_GAP = 0.08        # 主力连续换月跳空阈值 (见 roll_points 注释)
EM_INTERVAL = 4.0      # 东财间隔: 2.2s 实测偏激进(IP 级限流), 加大到 4.0s
EM_MAX_FAIL = 3        # 东财连续失败 N 次 -> 快速降级, 放弃整轮

# 代码 -> (名称, 板块/行业, 市场, 涨跌停幅度)
POOL = [
    # ===== 指数 =====
    ("sh000001", "上证指数", "大盘", "index", 0),
    ("sz399001", "深证成指", "大盘", "index", 0),
    ("sz399006", "创业板指", "大盘", "index", 0),
    ("sh000300", "沪深300", "大盘", "index", 0),
    ("sh000688", "科创50", "大盘", "index", 0),
    ("sh000016", "上证50", "大盘", "index", 0),
    ("sz399905", "中证500", "大盘", "index", 0),
    # ===== A股 · 白酒消费 =====
    ("sh600519", "贵州茅台", "白酒", "main", 10),
    ("sz000858", "五 粮 液", "白酒", "main", 10),
    ("sz000568", "泸州老窖", "白酒", "main", 10),
    ("sz002304", "洋河股份", "白酒", "main", 10),
    ("sh600809", "山西汾酒", "白酒", "main", 10),
    ("sh603288", "海天味业", "食品", "main", 10),
    ("sh600887", "伊利股份", "食品", "main", 10),
    ("sz002714", "牧原股份", "养殖", "main", 10),
    ("sh601888", "中国中免", "免税", "main", 10),
    ("sz300498", "温氏股份", "养殖", "gem", 20),
    # ===== A股 · 金融 =====
    ("sh601318", "中国平安", "保险", "main", 10),
    ("sh601601", "中国太保", "保险", "main", 10),
    ("sh601628", "中国人寿", "保险", "main", 10),
    ("sh600036", "招商银行", "银行", "main", 10),
    ("sz000001", "平安银行", "银行", "main", 10),
    ("sh601398", "工商银行", "银行", "main", 10),
    ("sh601288", "农业银行", "银行", "main", 10),
    ("sh601939", "建设银行", "银行", "main", 10),
    ("sh601988", "中国银行", "银行", "main", 10),
    ("sh601166", "兴业银行", "银行", "main", 10),
    ("sh600000", "浦发银行", "银行", "main", 10),
    ("sh601818", "光大银行", "银行", "main", 10),
    ("sz002142", "宁波银行", "银行", "main", 10),
    ("sh600030", "中信证券", "券商", "main", 10),
    ("sh601211", "国泰君安", "券商", "main", 10),
    ("sh600837", "海通证券", "券商", "main", 10),
    ("sz300059", "东方财富", "券商", "gem", 20),
    ("sh600570", "恒生电子", "金融IT", "main", 10),
    # ===== A股 · 新能源 / 光伏 / 电力设备 =====
    ("sz300750", "宁德时代", "锂电", "gem", 20),
    ("sz002594", "比亚迪", "新能源车", "main", 10),
    ("sh601012", "隆基绿能", "光伏", "main", 10),
    ("sh600438", "通威股份", "光伏", "main", 10),
    ("sh688599", "天合光能", "光伏", "star", 20),
    ("sz300124", "汇川技术", "工控", "gem", 20),
    ("sz002460", "赣锋锂业", "锂电", "main", 10),
    ("sh688008", "澜起科技", "半导体", "star", 20),
    # ===== A股 · 半导体 / 科技 =====
    ("sh688981", "中芯国际", "半导体", "star", 20),
    ("sh603986", "兆易创新", "半导体", "main", 10),
    ("sz002049", "紫光国微", "半导体", "main", 10),
    ("sz002371", "北方华创", "半导体设备", "main", 10),
    ("sh600703", "三安光电", "半导体", "main", 10),
    ("sh688111", "金山办公", "软件", "star", 20),
    ("sz002415", "海康威视", "安防", "main", 10),
    ("sz002475", "立讯精密", "消费电子", "main", 10),
    ("sz000725", "京东方A", "面板", "main", 10),
    ("sz300308", "中际旭创", "光模块", "gem", 20),
    ("sz002230", "科大讯飞", "人工智能", "main", 10),
    ("sz000063", "中兴通讯", "通信", "main", 10),
    ("sh600745", "闻泰科技", "半导体", "main", 10),
    # ===== A股 · 医药 =====
    ("sh600276", "恒瑞医药", "医药", "main", 10),
    ("sz300760", "迈瑞医疗", "医疗器械", "gem", 20),
    ("sh603259", "药明康德", "医药外包", "main", 10),
    ("sz300015", "爱尔眼科", "医疗", "gem", 20),
    ("sh600196", "复星医药", "医药", "main", 10),
    ("sz000538", "云南白药", "中药", "main", 10),
    ("sh600436", "片仔癀", "中药", "main", 10),
    # ===== A股 · 资源能源 =====
    ("sh601899", "紫金矿业", "有色", "main", 10),
    ("sh600028", "中国石化", "石化", "main", 10),
    ("sh601857", "中国石油", "石化", "main", 10),
    ("sh600309", "万华化学", "化工", "main", 10),
    ("sh600900", "长江电力", "电力", "main", 10),
    ("sh601985", "中国核电", "电力", "main", 10),
    ("sh600011", "华能国际", "电力", "main", 10),
    ("sh601088", "中国神华", "煤炭", "main", 10),
    ("sh600188", "兖矿能源", "煤炭", "main", 10),
    ("sh600585", "海螺水泥", "建材", "main", 10),
    # ===== A股 · 制造 / 地产 / 其他 =====
    ("sh601668", "中国建筑", "建筑", "main", 10),
    ("sz000002", "万 科 A", "地产", "main", 10),
    ("sh600048", "保利发展", "地产", "main", 10),
    ("sz000333", "美的集团", "家电", "main", 10),
    ("sz000651", "格力电器", "家电", "main", 10),
    ("sh600690", "海尔智家", "家电", "main", 10),
    ("sh600104", "上汽集团", "汽车", "main", 10),
    ("sz000157", "中联重科", "机械", "main", 10),
    ("sh601728", "中国电信", "通信运营", "main", 10),
    ("sh600009", "上海机场", "交运", "main", 10),
    ("sh601006", "大秦铁路", "交运", "main", 10),
    ("sz002027", "分众传媒", "传媒", "main", 10),
    ("sz300413", "芒果超媒", "传媒", "gem", 20),
    ("sh601111", "中国国航", "航空", "main", 10),
    ("sh600019", "宝钢股份", "钢铁", "main", 10),

    # ===== 港股 (腾讯真实历史日线) =====
    ("hk00700", "腾讯控股", "科技", "hk", 0),
    ("hk09988", "阿里巴巴", "电商", "hk", 0),
    ("hk03690", "美团", "本地生活", "hk", 0),
    ("hk01810", "小米集团", "科技", "hk", 0),
    ("hk09618", "京东", "电商", "hk", 0),
    ("hk00939", "建设银行", "银行", "hk", 0),
    ("hk01398", "工商银行", "银行", "hk", 0),
    ("hk03988", "中国银行", "银行", "hk", 0),
    ("hk00388", "香港交易所", "金融", "hk", 0),
    ("hk01299", "友邦保险", "保险", "hk", 0),
    ("hk02318", "中国平安", "保险", "hk", 0),
    ("hk09999", "网易", "科技", "hk", 0),
    ("hk09961", "携程", "旅游", "hk", 0),
    ("hk02015", "理想汽车", "新能源车", "hk", 0),
    ("hk09868", "小鹏汽车", "新能源车", "hk", 0),
    ("hk01211", "比亚迪股份", "新能源车", "hk", 0),
    ("hk02020", "安踏体育", "运动", "hk", 0),
    ("hk01698", "腾讯音乐", "文娱", "hk", 0),
    ("hk01024", "快手", "短视频", "hk", 0),
    ("hk09888", "百度", "科技", "hk", 0),
    ("hk06618", "京东健康", "医疗", "hk", 0),
    ("hk09633", "农夫山泉", "饮料", "hk", 0),
    ("hk00883", "中国海洋石油", "石化", "hk", 0),
    ("hk00857", "中国石油股份", "石化", "hk", 0),
    ("hk01088", "中国神华", "煤炭", "hk", 0),
    ("hk06862", "海底捞", "餐饮", "hk", 0),
    ("hk00291", "华润啤酒", "饮料", "hk", 0),
    ("hk01113", "长实集团", "地产", "hk", 0),

    # ===== 基金 / 固收 / REITs / 商品 (场内 ETF / LOF / 债券 / REIT) =====
    # 宽基指数
    ("sh510300", "沪深300ETF", "指数", "fd", 10),
    ("sh510050", "50ETF", "指数", "fd", 10),      # T03: 期权标的(上交所 50ETF 期权)
    ("sz159915", "创业板ETF", "指数", "fd", 10),
    ("sh510500", "中证500ETF", "指数", "fd", 10),
    ("sh510880", "红利ETF", "红利", "fd", 10),
    ("sz159905", "中证红利ETF", "红利", "fd", 10),
    ("sh511880", "银华日利", "货币ETF", "fd", 10),
    ("sz161725", "招商白酒", "白酒LOF", "fd", 10),
    ("sz163406", "兴全合润", "混合LOF", "fd", 10),
    ("sz161005", "富国天惠", "成长LOF", "fd", 10),
    # 商品 / 另类
    ("sh518880", "黄金ETF", "黄金", "fd", 10),
    ("sh501018", "南方原油LOF", "原油", "fd", 10),
    ("sz159985", "豆粕ETF", "农产品", "fd", 10),
    ("sz159980", "有色ETF", "有色金属", "fd", 10),
    ("sh513100", "纳指ETF", "美股QDII", "fd", 10),
    ("sh513500", "标普500ETF", "美股QDII", "fd", 10),
    # 固收 / 债券
    ("sh511010", "国债ETF", "国债", "fd", 10),
    ("sh511260", "十年国债ETF", "国债", "fd", 10),
    ("sh511360", "短融ETF", "短债", "fd", 10),
    ("sh511220", "城投债ETF", "信用债", "fd", 10),
    ("sh511380", "可转债ETF", "可转债", "fd", 10),
    # 行业 / 主题 ETF
    ("sh512800", "银行ETF", "银行", "fd", 10),
    ("sh512880", "证券ETF", "券商", "fd", 10),
    ("sh512660", "军工ETF", "军工", "fd", 10),
    ("sh512010", "医药ETF", "医药", "fd", 10),
    ("sh159928", "消费ETF", "消费", "fd", 10),
    ("sh512480", "半导体ETF", "半导体", "fd", 10),
    ("sz159995", "芯片ETF", "半导体", "fd", 10),
    ("sh515050", "5G通信ETF", "通信", "fd", 10),
    ("sh515030", "新能源车ETF", "新能源车", "fd", 10),
    ("sh515790", "光伏ETF", "光伏", "fd", 10),
    ("sh515220", "煤炭ETF", "煤炭", "fd", 10),
    ("sh512400", "有色金属ETF", "有色", "fd", 10),
    ("sh515210", "钢铁ETF", "钢铁", "fd", 10),
    ("sh159996", "家电ETF", "家电", "fd", 10),
    ("sh512690", "白酒ETF", "白酒", "fd", 10),
    ("sh515980", "人工智能ETF", "AI", "fd", 10),
    ("sz159770", "机器人ETF", "机器人", "fd", 10),
    ("sh512980", "传媒ETF", "传媒", "fd", 10),
    ("sz159865", "养殖ETF", "养殖", "fd", 10),
    ("sh512200", "房地产ETF", "地产", "fd", 10),
    ("sh159611", "电力ETF", "电力", "fd", 10),
    ("sh516780", "稀土ETF", "稀土", "fd", 10),
    ("sh516950", "基建ETF", "基建", "fd", 10),
    ("sz159792", "港股通互联网ETF", "港股通", "fd", 10),
    ("sh513050", "中概互联网ETF", "中概", "fd", 10),
    ("sh588000", "科创50ETF", "指数", "fd", 10),
    ("sh512170", "医疗ETF", "医疗", "fd", 10),
    ("sh515000", "科技ETF", "科技", "fd", 10),
    # 公募 REITs
    ("sh508056", "中金普洛斯REIT", "仓储物流", "fd", 10),
    ("sz180301", "红土盐田港REIT", "港口", "fd", 10),
    ("sh508018", "华夏交建REIT", "高速公路", "fd", 10),
    ("sh508027", "东吴苏园REIT", "产业园", "fd", 10),
    ("sh508000", "华安张江REIT", "产业园", "fd", 10),
    ("sh508006", "富国首创水务REIT", "环保", "fd", 10),
    ("sz180801", "中航首钢绿能REIT", "新能源", "fd", 10),

    # ===== 可转债 (T+0, 首日 ±57.3%/-43.3%, 次日起 ±20%, 免印花税/过户费) =====
    ("sh113616", "韦尔转债", "转债", "cb", 20),
    ("sz128136", "立讯转债", "转债", "cb", 20),
    ("sz127045", "牧原转债", "转债", "cb", 20),
    ("sh113056", "重银转债", "转债", "cb", 20),
    ("sz123138", "丝路转债", "转债", "cb", 20),
    ("sh110084", "贵燃转债", "转债", "cb", 20),
    ("sh110077", "洪城转债", "转债", "cb", 20),
    ("sz123155", "中陆转债", "转债", "cb", 20),
    ("sh113655", "欧22转债", "转债", "cb", 20),
    ("sh110067", "华安转债", "转债", "cb", 20),
    ("sz123151", "康医转债", "转债", "cb", 20),
    ("sh113671", "武进转债", "转债", "cb", 20),
    ("sz127089", "晶澳转债", "转债", "cb", 20),
    ("sh110093", "神马转债", "转债", "cb", 20),
    ("sh113658", "密卫转债", "转债", "cb", 20),
    ("sz123166", "蒙泰转债", "转债", "cb", 20),
    ("sh110085", "通22转债", "转债", "cb", 20),
    ("sz128145", "日丰转债", "转债", "cb", 20),

    # ===== 国债逆回购 (报价 = 年化利率%; 1000元起/1000元整数倍) =====
    ("sh204001", "GC001(1天)", "逆回购", "rp", 0),
    ("sh204002", "GC002(2天)", "逆回购", "rp", 0),
    ("sh204003", "GC003(3天)", "逆回购", "rp", 0),
    ("sh204004", "GC004(4天)", "逆回购", "rp", 0),
    ("sh204007", "GC007(7天)", "逆回购", "rp", 0),
    ("sh204014", "GC014(14天)", "逆回购", "rp", 0),
    ("sh204028", "GC028(28天)", "逆回购", "rp", 0),
    ("sh204091", "GC091(91天)", "逆回购", "rp", 0),
    ("sh204182", "GC182(182天)", "逆回购", "rp", 0),
    ("sz131810", "R-001(1天)", "逆回购", "rp", 0),
    ("sz131811", "R-002(2天)", "逆回购", "rp", 0),
    ("sz131800", "R-003(3天)", "逆回购", "rp", 0),
    ("sz131809", "R-004(4天)", "逆回购", "rp", 0),
    ("sz131801", "R-007(7天)", "逆回购", "rp", 0),
    ("sz131802", "R-014(14天)", "逆回购", "rp", 0),
    ("sz131803", "R-028(28天)", "逆回购", "rp", 0),
    ("sz131805", "R-091(91天)", "逆回购", "rp", 0),
    ("sz131806", "R-182(182天)", "逆回购", "rp", 0),
]

# 去重保持顺序
_seen = set()
POOL = [x for x in POOL if not (x[0] in _seen or _seen.add(x[0]))]
POOL_CODES = {p[0] for p in POOL}


# =====================================================================
#  合成序列 (确定性随机游走)
#  fx  : 公开接口无历史K线 -> 合成, 锚定真实区间
#  wm  : 银行理财为净值型产品, 非上市证券 -> 合成净值曲线
#  us  : 优先用东方财富真实日线, 抓不到才回退合成
# =====================================================================
def _seed(s):
    h = 2166136261
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def gen_synth(code, base, vol, drift, dates, scale, floor=None):
    """生成确定性 OHLCV 序列; scale=100(股价) 或 10000(汇率/净值)."""
    arr = [0] * (len(dates) * 5)
    rnd = random.Random(_seed(code))
    rate = base
    prev = base
    for i, d in enumerate(dates):
        shock = rnd.gauss(0, vol)
        rate = max(1e-6, rate * (1 + drift + shock))
        if floor is not None:
            rate = max(floor, rate)
        o = prev
        c = rate
        hi = max(o, c) * (1 + abs(rnd.gauss(0, vol * 0.6)))
        lo = min(o, c) * (1 - abs(rnd.gauss(0, vol * 0.6)))
        v = 1.0 + abs(rnd.gauss(0, 1.0))
        b = i * 5
        arr[b] = int(round(o * scale))
        arr[b + 1] = int(round(hi * scale))
        arr[b + 2] = int(round(lo * scale))
        arr[b + 3] = int(round(c * scale))
        arr[b + 4] = int(round(v * 1000))
        prev = c
    return arr


# 银行理财 R1-R5 净值型 (资管新规后净值化, 打破刚兑, 不保本)
# (code, name, level, base净值, 日波动, 日漂移)
WM_PRODUCTS = [
    ("wmR1", "现金管理类 · R1", "R1", 1.0000, 0.00012, 0.0180 / 252),
    ("wmR2", "固定收益类 · R2", "R2", 1.0000, 0.00055, 0.0350 / 252),
    ("wmR3", "固收+ · R3", "R3", 1.0000, 0.00280, 0.0500 / 252),
    ("wmR4", "权益类 · R4", "R4", 1.0000, 0.00750, 0.0600 / 252),
    ("wmR5", "衍生品类 · R5", "R5", 1.0000, 0.01400, 0.0700 / 252),
]

# 外汇 (无历史K线 -> 合成)
FX_PAIRS = [
    ("fxUSDCNY", "美元/人民币", "外汇", 7.18, 0.0022, 0.00003),
    ("fxEURUSD", "欧元/美元", "外汇", 1.0850, 0.0038, 0.00001),
    ("fxGBPUSD", "英镑/美元", "外汇", 1.2700, 0.0043, 0.0),
    ("fxUSDJPY", "美元/日元", "外汇", 151.50, 0.0036, 0.0),
    ("fxAUDUSD", "澳元/美元", "外汇", 0.6600, 0.0048, 0.0),
    ("fxUSDHKD", "美元/港元", "外汇", 7.8100, 0.0008, 0.0),
]

# 美股: 腾讯 usfqkline 需带交易所后缀 (AAPL.OQ / TSM.N), 后缀由实时报价自动发现
# (code, name, ind, 合成基准价, vol, drift, 裸代码)
US_LIST = [
    ("usAAPL", "苹果", "科技", 341.0, 0.022, 0.0004, "AAPL"),
    ("usMSFT", "微软", "科技", 430.0, 0.018, 0.0004, "MSFT"),
    ("usNVDA", "英伟达", "半导体", 125.0, 0.035, 0.0006, "NVDA"),
    ("usTSLA", "特斯拉", "新能源车", 250.0, 0.035, 0.0, "TSLA"),
    ("usAMZN", "亚马逊", "电商", 185.0, 0.022, 0.0003, "AMZN"),
    ("usGOOGL", "谷歌", "科技", 175.0, 0.020, 0.0003, "GOOGL"),
    ("usMETA", "Meta", "社交", 560.0, 0.025, 0.0004, "META"),
    ("usAMD", "AMD", "半导体", 150.0, 0.035, 0.0003, "AMD"),
    ("usNFLX", "奈飞", "文娱", 700.0, 0.026, 0.0005, "NFLX"),
    ("usPDD", "拼多多", "电商", 105.0, 0.040, 0.0005, "PDD"),
    ("usTSM", "台积电", "半导体", 95.0, 0.026, 0.0004, "TSM"),
    ("usINTC", "英特尔", "半导体", 22.0, 0.038, -0.0002, "INTC"),
    ("usQCOM", "高通", "半导体", 150.0, 0.028, 0.0003, "QCOM"),
    ("usORCL", "甲骨文", "软件", 160.0, 0.022, 0.0004, "ORCL"),
    ("usCRM", "赛富时", "软件", 260.0, 0.024, 0.0003, "CRM"),
    ("usJPM", "摩根大通", "银行", 210.0, 0.016, 0.0003, "JPM"),
    ("usGS", "高盛", "投行", 480.0, 0.019, 0.0003, "GS"),
    ("usBRK", "伯克希尔", "综合", 410.0, 0.014, 0.0002, "BRK.B"),
    ("usV", "Visa", "支付", 280.0, 0.015, 0.0003, "V"),
    ("usMA", "万事达", "支付", 460.0, 0.015, 0.0003, "MA"),
    ("usWMT", "沃尔玛", "零售", 80.0, 0.014, 0.0003, "WMT"),
    ("usKO", "可口可乐", "消费", 62.0, 0.013, 0.0001, "KO"),
    ("usMCD", "麦当劳", "餐饮", 290.0, 0.013, 0.0002, "MCD"),
    ("usNKE", "耐克", "服饰", 75.0, 0.020, -0.0001, "NKE"),
    ("usJNJ", "强生", "医药", 150.0, 0.015, 0.0001, "JNJ"),
    ("usPFE", "辉瑞", "医药", 26.0, 0.021, -0.0002, "PFE"),
    ("usXOM", "埃克森美孚", "石化", 115.0, 0.018, 0.0002, "XOM"),
    ("usBA", "波音", "航空制造", 180.0, 0.028, -0.0001, "BA"),
    ("usDIS", "迪士尼", "文娱", 95.0, 0.024, 0.0002, "DIS"),
    ("usBABA", "阿里巴巴ADR", "电商", 80.0, 0.030, 0.0002, "BABA"),
]

# =====================================================================
#  T03 · 四类另类投资品种 (期货 / 期权 / 数字资产 / 私募·信托 / 另类)
# ---------------------------------------------------------------------
#  铁律: 规则常量一律不进 snapshot —— 合约乘数、保证金率、权利金参数、
#  起投门槛、锁定期、票息、敲入敲出线 均由前端 game.js 持有。
#  快照只承载: 序列(series) + 元信息(meta) + 独立日期轴(ax) + 换月点(rol)。
# =====================================================================

# 期货主力连续 —— 新浪 InnerFuturesNewService (UTF-8 JSONP, 需剥壳)
# 实测: AU0/AG0/SC0/RB0/CU0/I0/M0 七个全部可用, 接口返回全量历史(AU0 4561 根)
# (code, 名称, 行业, market, 新浪symbol, 涨跌停%)
FUT_LIST = [
    ("futAU", "沪金主力", "贵金属", "fut", "AU0", 9),
    ("futAG", "沪银主力", "贵金属", "fut", "AG0", 11),
    ("futSC", "原油主力", "能源", "fut", "SC0", 9),
    ("futRB", "螺纹钢主力", "黑色", "fut", "RB0", 8),
    ("futCU", "沪铜主力", "有色", "fut", "CU0", 7),
    ("futI", "铁矿石主力", "黑色", "fut", "I0", 9),
    ("futM", "豆粕主力", "农产品", "fut", "M0", 7),
]

# 期货抓取失败时的合成参数 (参考价 / 日波动), 必须逐品种给出, 不能共用一套
FUT_SYNTH = {
    "futAU": (560.0, 0.012),      # 元/克
    "futAG": (7500.0, 0.018),     # 元/千克
    "futSC": (552.0, 0.022),      # 元/桶
    "futRB": (3210.0, 0.015),     # 元/吨
    "futCU": (78000.0, 0.013),    # 元/吨
    "futI": (780.0, 0.020),       # 元/吨
    "futM": (3360.0, 0.014),      # 元/吨
}

# 数字资产 —— Binance data-api (实测 CORS `*`, 运行期亦可直连), 备 Gate.io
# 计价: 接口为 USDT 计价, 构建期用真实 USD/CNY 在岸价折算为人民币
# (code, 名称, 行业, market, Binance symbol, Gate pair, 合成基准¥, 合成日波动)
CRY_LIST = [
    ("cryBTC", "比特币", "数字资产", "cry", "BTCUSDT", "BTC_USDT", 460000.0, 0.040),
    ("cryETH", "以太坊", "数字资产", "cry", "ETHUSDT", "ETH_USDT", 23000.0, 0.045),
]

# 期权 —— Q7: 期权链运行时由 BSM 生成, 不落盘; 快照只存「标的 ETF」的真实序列
# (code, 名称, 行业, market, 底层 ETF 代码)
OPT_LIST = [
    ("opt510300", "300ETF期权", "期权", "opt", "sh510300"),
    ("opt510050", "50ETF期权", "期权", "opt", "sh510050"),
]

# 私募 / 信托 (PM) —— 非净值型, 锁定期内不可赎回; 序列为「应计单位净值」
# (code, 名称, 行业, market, 年化利率)
PM_PRODUCTS = [
    ("pmFUND", "私募固收", "私募", "pm", 0.055),
    ("pmTRUST", "信托计划", "信托", "pm", 0.065),
]

# 另类 / 结构性 (ALT) —— 序列 = 挂钩标的的真实序列, 收益规则(敲入敲出/参与率)在前端
# (code, 名称, 行业, market, 挂钩标的)
ALT_PRODUCTS = [
    ("altSNOW", "雪球·中证500", "结构化", "alt", "sz399905"),
    ("altLINK", "挂钩沪深300", "结构化", "alt", "sh000300"),
    ("altGOLD", "实物金条", "贵金属", "alt", "futAU"),
    ("altACC", "银行积存金", "贵金属", "alt", "futAU"),
]

# 合规财经 RSS (构建期烘焙为 SNAPSHOT.news)
RSS_FEEDS = [
    ("东方财富", "https://rss.eastmoney.com/rss_partener.xml", 60),
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", 20),
]

# 分红标的 (高股息; 用于反推除权日与每股派息)
DIV_CODES = [
    "sh601398", "sh601288", "sh601939", "sh601988", "sh600036", "sh601166",
    "sh600028", "sh601857", "sh600900", "sh601985", "sh600011", "sh601006",
    "sh600585", "sh601668", "sh600104", "sh601088", "sh600019", "sh601818",
]


# =====================================================================
#  数据源适配器 —— 统一返回 [[date, open, close, high, low, volume], ...]
# =====================================================================
def _open(url, referer, timeout=25):
    h = {"User-Agent": UA, "Referer": referer, "Accept": "*/*", "Connection": "close"}
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.read()


def _looks_blocked(raw):
    """侦测 WAF / 限流页面"""
    head = raw[:2048].lstrip().lower()
    return head.startswith(b"<") or b"waf" in head or b"<html" in head


def src_tencent(code, n):
    """腾讯财经 —— 主源。注意: 必须用 ifzq.gtimg.cn, web.ifzq 已被 WAF 拦截。"""
    urls = [
        f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{n},",
        f"https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={code},day,,,{n}",
    ]
    for u in urls:
        try:
            raw = _open(u, "https://gu.qq.com/")
            if _looks_blocked(raw):
                continue
            j = json.loads(raw.decode("utf-8", "ignore"))
            node = (j.get("data") or {}).get(code) or {}
            rows = node.get("day") or node.get("qfqday") or node.get("kline") or []
            if rows:
                return [[r[0], r[1], r[2], r[3], r[4], r[5]] for r in rows]
        except Exception:
            continue
    return None


def em_secid(code):
    """东财 secid: 1=沪 0=深 116=港股 105/106/107=美股"""
    if code.startswith("hk"):
        return "116." + code[2:]
    if code.startswith("sh"):
        return "1." + code[2:]
    if code.startswith("sz"):
        return "0." + code[2:]
    return None


def src_eastmoney(code, n):
    """东方财富 —— 覆盖面最广(含美股), 但限流严格, 调用方需强节流。"""
    secids = []
    if code.startswith("us"):
        tick = code[2:]
        secids = [f"{p}.{tick}" for p in (105, 106, 107)]
    else:
        s = em_secid(code)
        if not s:
            return None
        secids = [s]
    for secid in secids:
        u = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?"
             f"secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
             f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
             f"&klt=101&fqt=0&end=20500101&lmt={n}")
        try:
            raw = _open(u, "https://quote.eastmoney.com/")
            if _looks_blocked(raw):
                continue
            j = json.loads(raw.decode("utf-8", "ignore"))
            d = j.get("data")
            if not d:
                continue
            ks = d.get("klines") or []
            rows = []
            for s in ks:
                p = s.split(",")
                if len(p) < 6:
                    continue
                rows.append([p[0], p[1], p[2], p[3], p[4], p[5]])   # d,o,c,h,l,v
            if len(rows) >= MIN_ROWS:
                return rows
        except Exception:
            continue
    return None


def src_sina(code, n):
    """新浪财经 —— 第三源。港股为空。"""
    u = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
         f"CN_MarketData.getKLineData?symbol={code}&scale=240&ma=no&datalen={n}")
    try:
        raw = _open(u, "https://finance.sina.com.cn/")
        if _looks_blocked(raw):
            return None
        j = json.loads(raw.decode("utf-8", "ignore"))
        if not isinstance(j, list):
            return None
        rows = []
        for r in j:
            rows.append([r["day"][:10], r["open"], r["close"], r["high"],
                         r["low"], r.get("volume", 0)])
        return rows if len(rows) >= MIN_ROWS else None
    except Exception:
        return None


# ---------------- 美股专用数据源 ----------------
def discover_us_codes(tickers):
    """通过腾讯实时报价发现美股的真实交易所后缀 (AAPL -> AAPL.OQ / TSM -> TSM.N)。
    返回 {裸代码: 腾讯行情代码(含 us 前缀)}。"""
    out = {}
    for part in [tickers[i:i + 40] for i in range(0, len(tickers), 40)]:
        u = "https://qt.gtimg.cn/q=" + ",".join("us" + t.replace(".", "") for t in part)
        try:
            txt = _open(u, "https://gu.qq.com/").decode("gbk", "ignore")
        except Exception:
            continue
        codes = []
        for line in txt.split("\n"):
            if "=" not in line:
                continue
            f = line.split("=", 1)[1].strip().strip(";").strip('"').split("~")
            if len(f) > 3 and f[2]:
                codes.append(f[2])          # 例: AAPL.OQ
        for t, c in zip(part, codes):       # 腾讯按请求顺序返回
            if "." in c:
                out[t] = "us" + c
    return out


def src_tencent_us(code, n):
    """腾讯美股日线 —— 必须带交易所后缀 (usAAPL.OQ), 否则返回 0 行。"""
    u = f"https://ifzq.gtimg.cn/appstock/app/usfqkline/get?param={code},day,,,{n},qfq"
    try:
        raw = _open(u, "https://gu.qq.com/")
        if _looks_blocked(raw):
            return None
        j = json.loads(raw.decode("utf-8", "ignore"))
        d = j.get("data") or {}
        node = d.get(code) or {}
        rows = node.get("qfqday") or node.get("day") or []
        if len(rows) < MIN_ROWS:
            return None
        return [[r[0], r[1], r[2], r[3], r[4], r[5]] for r in rows]
    except Exception:
        return None


def src_sina_us(ticker, n):
    """新浪美股日线 (1984 年至今完整历史), 作为腾讯的备用源。"""
    u = ("https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20t=/"
         f"US_MinKService.getDailyK?symbol={ticker}&___qn=3")
    try:
        raw = _open(u, "https://finance.sina.com.cn/")
        if _looks_blocked(raw):
            return None
        txt = raw.decode("utf-8", "ignore")
        i, j = txt.find("(["), txt.rfind("])")
        if i < 0 or j < 0:
            return None
        arr = json.loads(txt[i + 1:j + 1])
        rows = [[r["d"][:10], r["o"], r["c"], r["h"], r["l"], r.get("v", 0)]
                for r in arr if r.get("d")]
        if len(rows) < MIN_ROWS:
            return None
        return rows[-n:]
    except Exception:
        return None


# ---------------- 期货 (新浪, 独立日期轴 FU) ----------------
def _jsonp_peel(txt):
    """新浪期货 JSONP 剥壳。
    实测原文本体: /*<script>location.href='//sina.com';</script>*/\\nvar t=([...])
    故不能整体 json.loads, 需按 '([' ... '])' 定位后再解析 (UTF-8, 非 GBK)。"""
    i, j = txt.find("(["), txt.rfind("])")
    if i < 0 or j < 0:
        return None
    try:
        return json.loads(txt[i + 1:j + 1])
    except Exception:
        return None


def src_sina_futures(symbol, n):
    """新浪期货主力连续日线。字段 d,o,h,l,c,v,p(持仓),s(结算)。
    接口返回全量历史(AU0 实测 4561 根 ≈520KB), 构建期只取末 n 根以控体积。"""
    u = ("https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/"
         f"InnerFuturesNewService.getDailyKLine?symbol={symbol}")
    try:
        raw = _open(u, "https://finance.sina.com.cn/", timeout=30)
        if _looks_blocked(raw):
            return None
        arr = _jsonp_peel(raw.decode("utf-8", "ignore"))
        if not isinstance(arr, list):
            return None
        rows = []
        for r in arr:
            if not r.get("d") or not r.get("c"):
                continue
            rows.append([r["d"][:10], r["o"], r["c"], r["h"], r["l"], r.get("v", 0)])
        return rows[-n:] if len(rows) >= MIN_ROWS else None
    except Exception:
        return None


def src_sina_futures_rt(symbol):
    """新浪期货实时 (GB18030, 必须带 Referer)。实测 44 段。
    无 CORS -> 浏览器运行期拿不到, 仅构建期使用(烘焙校验/对账)。
    关键段位: 0名称 1时间 2开 3高 4低 8最新 10昨结算 13成交量 14持仓 17日期"""
    u = f"https://hq.sinajs.cn/list=nf_{symbol}"

    def _num(seg, k):
        try:
            v = float(seg[k])
            return v if v == v else 0.0
        except Exception:
            return 0.0

    try:
        txt = _open(u, "https://finance.sina.com.cn/", timeout=20).decode("gb18030", "ignore")
        if '="' not in txt:
            return None
        seg = txt.split('="', 1)[1].split('"')[0].split(",")
        if len(seg) < 18:
            return None
        return {"name": seg[0], "time": seg[1], "open": _num(seg, 2),
                "high": _num(seg, 3), "low": _num(seg, 4), "last": _num(seg, 8),
                "presettle": _num(seg, 10), "vol": _num(seg, 13),
                "oi": _num(seg, 14), "date": seg[17]}
    except Exception:
        return None


# ---------------- 数字资产 (独立日期轴 CR, UTC 00:00 收线) ----------------
def src_binance_dataapi(symbol, n):
    """Binance data-api 日线。实测可用: api.binance.com 全系不通, 必须用 data-api.binance.vision。
    响应 CORS `*`, 故运行期(实盘同步)也能直连。kline=[openTime,o,h,l,c,v,closeTime,...]
    日线按 UTC 00:00 收线 -> 日期取 openTime 的 UTC 日期。"""
    n = max(1, min(int(n), 1000))
    u = (f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}"
         f"&interval=1d&limit={n}")
    try:
        raw = _open(u, "https://www.binance.com/", timeout=25)
        if _looks_blocked(raw):
            return None
        arr = json.loads(raw.decode("utf-8", "ignore"))
        if not isinstance(arr, list):
            return None
        rows = []
        for r in arr:
            d = datetime.datetime.fromtimestamp(
                r[0] / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
            rows.append([d, r[1], r[4], r[2], r[3], r[5]])     # d,o,c,h,l,v
        return rows if len(rows) >= MIN_ROWS else None
    except Exception:
        return None


def src_gateio(pair, n):
    """Gate.io 现货日线(备用源)。字段顺序与直觉相反:
    [ts, 报价成交量, close, high, low, open, baseVol, closed] —— 第 3 位是收盘而非开盘。"""
    n = max(1, min(int(n), 1000))
    u = (f"https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair={pair}"
         f"&interval=1d&limit={n}")
    try:
        raw = _open(u, "https://www.gate.io/", timeout=25)
        if _looks_blocked(raw):
            return None
        arr = json.loads(raw.decode("utf-8", "ignore"))
        if not isinstance(arr, list):
            return None
        rows = []
        for r in arr:
            d = datetime.datetime.fromtimestamp(
                int(r[0]), datetime.timezone.utc).strftime("%Y-%m-%d")
            rows.append([d, r[5], r[2], r[3], r[4], r[6]])     # d,o,c,h,l,v
        return rows if len(rows) >= MIN_ROWS else None
    except Exception:
        return None


def src_usdcny():
    """美元/人民币在岸价(新浪外汇)。腾讯 fx_susdcny 实测返回 v_pv_none_match, 不可用。
    用于把 USDT 计价折算为人民币计价(Q1: 全作品统一人民币)。"""
    u = "https://hq.sinajs.cn/list=fx_susdcny"
    try:
        txt = _open(u, "https://finance.sina.com.cn/", timeout=15).decode("gb18030", "ignore")
        if '="' not in txt:
            return None
        seg = txt.split('="', 1)[1].split('"')[0].split(",")
        v = float(seg[1])
        return v if 3.0 < v < 12.0 else None      # 合理性护栏
    except Exception:
        return None


# ---------------- 换月跳空清洗 & 独立日期轴重采样 ----------------
def roll_points(rows, thr=ROLL_GAP):
    """主力连续(AU0/RB0...)换月日的非经济性跳空点, 返回 [date, ...]。

    判据取「隔夜跳空 |今开/昨收 − 1|」而非「日收益 |今收/昨收 − 1|」:
      换月是旧合约换到新合约的拼接, 价差在开盘瞬间一次性体现 -> 隔夜跳空大;
      而真实剧烈波动是日内走出来的 -> 隔夜跳空小、日收益大。
    实测反例(若按日收益剔除会误杀真实行情):
      沪金 AU0 2026-02-02 日收益 13.16%, 但隔夜跳空仅 1.84% -> 真实日内波动, 不是换月。
    实测正例: 豆粕 M0 2023-12-11 隔夜跳空 13.83%; 白银 AG0 2026-02-24 隔夜跳空 13.00%。
    """
    out = []
    for i in range(1, len(rows)):
        try:
            pc = float(rows[i - 1][2])
            o = float(rows[i][1])
        except Exception:
            continue
        if pc > 0 and abs(o / pc - 1) > thr:
            out.append(rows[i][0])
    return out


def resample_axis(ax_dates, rows, main_dates, scale):
    """把独立日期轴上的序列「区间聚合」重采样到主日历, 返回定长 arr(×5)。

    区间 = (上一主日历日, 当日]。这样加密的周末行情会被聚合进周一那根 K 的
    O/H/L/C 与成交量里, 而不是被当成停牌做前向填充而丢失 —— 这正是
    「独立日期轴」要防的错位。没有新行情的日子(如期货休市)才前向平盘。
    """
    arr = [0] * (len(main_dates) * 5)
    p = 0
    prev_c = None
    for i, to in enumerate(main_dates):
        frm = main_dates[i - 1] if i else ""
        o = h = l = c = None
        v = 0.0
        n = 0
        while p < len(ax_dates) and ax_dates[p] <= to:
            d = ax_dates[p]
            r = rows.get(d)
            p += 1
            if not r or d <= frm:
                continue
            oo, cc, hh, ll, vv = r
            if cc is None or cc <= 0:
                continue
            if n == 0:
                o, h, l = oo, hh, ll
            else:
                h = max(h, hh)
                l = min(l, ll)
            c = cc
            v += vv
            n += 1
        b = i * 5
        if n:
            arr[b] = int(round(o * scale))
            arr[b + 1] = int(round(h * scale))
            arr[b + 2] = int(round(l * scale))
            arr[b + 3] = int(round(c * scale))
            arr[b + 4] = int(round(v))
            prev_c = arr[b + 3]
        elif prev_c is not None:
            arr[b] = arr[b + 1] = arr[b + 2] = arr[b + 3] = prev_c
            arr[b + 4] = 0
    return arr


# ---------------- 构建期烘焙合规财经 RSS ----------------
def fetch_news():
    items = []
    for src, url, cap in RSS_FEEDS:
        try:
            raw = _open(url, "https://www.eastmoney.com/")
            txt = raw.decode("utf-8-sig", "ignore")
        except Exception as e:
            print(f"  [news] {src} 抓取失败: {type(e).__name__}", flush=True)
            continue
        n = 0
        for m in re.finditer(r"<item[\s>][\s\S]*?</item>|<entry[\s>][\s\S]*?</entry>",
                             txt, re.I):
            blk = m.group(0)
            t = re.search(r"<title[^>]*>([\s\S]*?)</title>", blk, re.I)
            if not t:
                continue
            title = html.unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))).strip()
            title = re.sub(r"\s+", " ", title)
            if not title or len(title) < 6:
                continue
            d = re.search(r"<(pubDate|updated|published)[^>]*>([\s\S]*?)</", blk, re.I)
            lk = re.search(r"<link[^>]*>([\s\S]*?)</link>", blk, re.I) or \
                 re.search(r'<link[^>]*href="([^"]+)"', blk, re.I)
            items.append({
                "t": title[:120], "src": src,
                "d": (d.group(2).strip() if d else ""),
                "u": (lk.group(1).strip() if lk else "")
            })
            n += 1
            if n >= cap:
                break
        print(f"  [news] {src}: {n} 条", flush=True)
    return items


# =====================================================================
#  抓取编排: 三次 pass (腾讯批量 -> 东财节流 -> 新浪节流)
# =====================================================================
def fetch_tencent_pass(codes):
    out = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(src_tencent, c, DAYS): c for c in codes}
        done = 0
        for f in as_completed(futs):
            c = futs[f]
            try:
                rows = f.result()
            except Exception:
                rows = None
            if rows:
                out[c] = rows
            done += 1
            if done % 20 == 0 or done == len(codes):
                print(f"    腾讯 {done}/{len(codes)} 成功 {len(out)}", flush=True)
    return out


def fetch_serial_pass(codes, fn, label, interval, max_consec_fail=0, retries=2):
    """东财/新浪: 严格串行 + 间隔, 避免被限流断连。

    东财是 IP 级限流炸弹(实测连续请求后连茅台对照组都 RemoteDisconnected),
    故对东财额外开: 指数退避 + 连续失败 N 次即快速降级放弃整轮。
    max_consec_fail=0 表示不做快速降级(新浪等温和源沿用旧行为)。
    """
    out = {}
    consec = 0
    for i, c in enumerate(codes):
        rows = None
        wait = interval
        for _ in range(retries + 1):
            rows = fn(c, DAYS)
            if rows:
                break
            time.sleep(wait)
            wait = min(wait * 2, 60)          # 指数退避
        if rows:
            out[c] = rows
            consec = 0
        else:
            consec += 1
            if max_consec_fail and consec >= max_consec_fail:
                print(f"    {label} 连续 {consec} 次失败 -> 快速降级, "
                      f"放弃剩余 {len(codes) - i - 1} 项", flush=True)
                break
        if (i + 1) % 5 == 0 or i + 1 == len(codes):
            print(f"    {label} {i+1}/{len(codes)} 成功 {len(out)}", flush=True)
        time.sleep(interval)
    return out


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(root, "data", "snapshot.js")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    pool_codes = [p[0] for p in POOL]
    us_codes = [u[0] for u in US_LIST]
    all_codes = pool_codes + us_codes
    print(f"目标 {len(all_codes)} 个标的 (POOL {len(pool_codes)} + 美股 {len(us_codes)}), "
          f"每标的最多 {DAYS} 个交易日", flush=True)

    result = {}
    source_of = {}
    tick_of = {u[0]: u[6] for u in US_LIST}

    # ---- pass 1: 腾讯 A股/港股/ETF/债券/可转债/逆回购/指数 ----
    print("\n[1/8] 腾讯财经 (A股/港股/ETF/债券/可转债/逆回购/指数) ...", flush=True)
    p1 = fetch_tencent_pass(pool_codes)
    for c, r in p1.items():
        result[c] = r
        source_of[c] = "腾讯"
    print(f"  腾讯命中 {len(p1)}/{len(pool_codes)}", flush=True)

    # ---- pass 2: 腾讯美股 (必须带交易所后缀, 否则只有 2 行) ----
    print(f"\n[2/8] 腾讯财经美股 ({len(us_codes)} 项, 自动发现交易所后缀) ...", flush=True)
    us_map = discover_us_codes(list(tick_of.values()))
    print(f"  发现后缀 {len(us_map)}/{len(tick_of)}", flush=True)

    def _us_one(game_code):
        fc = us_map.get(tick_of.get(game_code))
        return src_tencent_us(fc, DAYS) if fc else None

    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(_us_one, c): c for c in us_codes}
        for f in as_completed(futs):
            c = futs[f]
            try:
                rows = f.result()
            except Exception:
                rows = None
            if rows:
                result[c] = rows
                source_of[c] = "腾讯US"
    print(f"  腾讯美股命中 {len([c for c in us_codes if c in result])}/{len(us_codes)}", flush=True)

    # ---- pass 3: 新浪美股 (备用源) ----
    need_us = [c for c in us_codes if c not in result]
    if need_us:
        print(f"\n[3/8] 新浪财经美股 ({len(need_us)} 项) ...", flush=True)
        for c in need_us:
            rows = src_sina_us(tick_of.get(c, ""), DAYS)
            if rows:
                result[c] = rows
                source_of[c] = "新浪US"
            time.sleep(0.4)
        print(f"  新浪美股命中 {len([c for c in need_us if c in result])}/{len(need_us)}", flush=True)

    # ---- pass 4: 东方财富 (兜底; 限流严格) ----
    need_em = [c for c in all_codes if c not in result]
    if need_em:
        print(f"\n[4/8] 东方财富 ({len(need_em)} 项, 串行节流) ...", flush=True)
        p4 = fetch_serial_pass(need_em, src_eastmoney, "东财", EM_INTERVAL,
                                  max_consec_fail=EM_MAX_FAIL)
        for c, r in p4.items():
            result[c] = r
            source_of[c] = "东财"
        print(f"  东财命中 {len(p4)}/{len(need_em)}", flush=True)

    # ---- pass 5: 新浪 (兜底) ----
    need_sina = [c for c in all_codes if c not in result]
    if need_sina:
        print(f"\n[5/8] 新浪财经 ({len(need_sina)} 项, 串行节流) ...", flush=True)
        p5 = fetch_serial_pass(need_sina, src_sina, "新浪", 0.45)
        for c, r in p5.items():
            result[c] = r
            source_of[c] = "新浪"
        print(f"  新浪命中 {len(p5)}/{len(need_sina)}", flush=True)

    # ---- 汇总 ----
    from collections import Counter
    print("\n抓取来源分布: " + ", ".join(
        f"{k}={v}" for k, v in Counter(source_of.values()).most_common()), flush=True)

    # ---- 交易日基准 (优先上证指数) ----
    anchor = result.get("sh000001")
    if not anchor:
        for alt in ("sh000300", "sz399001", "sh600519"):
            if result.get(alt):
                anchor = result[alt]
                print(f"  [warn] 无上证指数, 以 {alt} 为交易日基准", flush=True)
                break
    if not anchor:
        print("[FATAL] 无任何可用基准序列", flush=True)
        sys.exit(1)

    all_dates = sorted({r[0] for c in result for r in result[c]})
    all_dates = all_dates[-DAYS:]
    dmap = {d: i for i, d in enumerate(all_dates)}
    print(f"交易日区间: {all_dates[0]} ~ {all_dates[-1]}  共 {len(all_dates)} 天", flush=True)

    # ---- pass 6/7: 独立日期轴的另类品种 (期货 FU / 数字资产 CR) ----
    #      这两类有自己的交易日历, 绝不并入 all_dates 主日历:
    #      加密 7x24 按 UTC 00:00 收线, 期货按各自交易日历。
    axes = {}
    rolls = {}

    print(f"\n[6/8] 期货主力连续 (新浪, 独立日期轴 FU, {len(FUT_LIST)} 个) ...", flush=True)
    fu_raw = {}
    for code, name, ind, market, sym, lim in FUT_LIST:
        rows = src_sina_futures(sym, FU_DAYS)
        if rows:
            fu_raw[code] = rows
        print(f"    {sym:<4} {len(rows) if rows else 0:>5} 根"
              f"{'  ' + rows[-1][0] + ' c=' + rows[-1][2] if rows else '  FAIL'}", flush=True)
        time.sleep(0.35)

    print(f"\n[7/8] 数字资产 (Binance data-api -> Gate.io, 独立日期轴 CR, "
          f"{len(CRY_LIST)} 个) ...", flush=True)
    fxu = src_usdcny()
    print(f"  USD/CNY 在岸价 = {fxu if fxu else '取不到(将按 1:1 记 USDT, 需人工核对)'}", flush=True)
    cr_raw = {}
    for code, name, ind, market, bsym, gpair, base, vol in CRY_LIST:
        rows = src_binance_dataapi(bsym, CR_DAYS)
        src = "Binance"
        if not rows:
            rows = src_gateio(gpair, CR_DAYS)
            src = "Gate.io"
        if rows and fxu:
            # USDT 计价 -> 人民币计价 (成交量为基础币数量, 不折算)
            rows = [[r[0]] + [("%.6f" % (float(r[k]) * fxu)) for k in (1, 2, 3, 4)] + [r[5]]
                    for r in rows]
        if rows:
            cr_raw[code] = rows
        print(f"    {bsym:<8} {len(rows) if rows else 0:>5} 根 "
              f"({src if rows else 'FAIL'})"
              f"{'  ' + rows[-1][0] + ' c=' + ('%.2f' % float(rows[-1][2])) if rows else ''}",
              flush=True)
        time.sleep(0.3)

    # ---- 退市/强赎剔除 (末个交易日过于陈旧) ----
    cutoff = all_dates[max(0, len(all_dates) - 1 - STALE_TOL)]
    dropped = []
    for c in list(result.keys()):
        rows = result[c]
        last_d = max(r[0] for r in rows)
        market = next((p[3] for p in POOL if p[0] == c), "us" if c.startswith("us") else "?")
        if market == "rp":          # 逆回购无退市概念
            continue
        if last_d < cutoff:
            dropped.append((c, last_d))
            del result[c]
    if dropped:
        print(f"剔除 {len(dropped)} 个数据陈旧(疑似退市/强赎)标的:", flush=True)
        for c, d in dropped[:40]:
            print(f"    - {c} 末交易日 {d}", flush=True)

    # ---- 对齐为定长序列 ----
    series = {}
    for c in sorted(result.keys()):
        rows = {r[0]: r for r in result[c]}
        arr = [0] * (len(all_dates) * 5)
        last = None
        last_close = None
        filled = 0
        for i, d in enumerate(all_dates):
            r = rows.get(d)
            if r:
                o, cl, h, l, v = (float(r[1]), float(r[2]), float(r[3]),
                                  float(r[4]), float(r[5]))
                last = (o, h, l, cl, v)
                last_close = cl
                filled += 1
            elif last is not None:
                o = h = l = cl = last_close   # 停牌: 沿用上一收盘价平盘
                v = 0.0
            else:
                continue
            b = i * 5
            arr[b] = int(round(o * 100))
            arr[b + 1] = int(round(h * 100))
            arr[b + 2] = int(round(l * 100))
            arr[b + 3] = int(round(cl * 100))
            arr[b + 4] = int(round(v))
        series[c] = arr
    print(f"对齐完成: {len(series)} 个标的 × {len(all_dates)} 天", flush=True)

    # ---- meta ----
    # meta 第 6 位 = 独立日期轴名("" 表示跟随主日历 all_dates)
    meta = [[p[0], p[1], p[2], p[3], p[4], ""] for p in POOL if p[0] in series]

    # ---- 美股: 抓到的用真实数据, 未抓到的才合成 ----
    from collections import Counter as _C
    synth = []
    for code, name, ind, base, vol, drift, _tick in US_LIST:
        meta.append([code, name, ind, "us", 0, ""])
        if code not in series:
            series[code] = gen_synth(code, base, vol, drift, all_dates, 100)
            synth.append(code)
    us_real = len(US_LIST) - len(synth)
    print(f"美股: 真实 {us_real} 个, 合成 {len(synth)} 个"
          + (f" ({', '.join(synth)})" if synth else ""), flush=True)

    # ---- 外汇 / 银行理财: 合成 ----
    for code, name, ind, base, vol, drift in FX_PAIRS:
        series[code] = gen_synth(code, base, vol, drift, all_dates, 10000)
        meta.append([code, name, ind, "fx", 0, ""])
    for code, name, level, base, vol, drift in WM_PRODUCTS:
        series[code] = gen_synth(code, base, vol, drift, all_dates, 10000, floor=0.60)
        meta.append([code, name, f"理财{level}", "wm", 0, ""])
    synthetic = set(synth) | {p[0] for p in FX_PAIRS} | {w[0] for w in WM_PRODUCTS}
    print(f"合成: 外汇 {len(FX_PAIRS)} + 银行理财 {len(WM_PRODUCTS)}", flush=True)

    # ==================================================================
    #  另类品种落盘: 独立日期轴 -> 换月点 -> 区间聚合重采样 -> meta
    # ==================================================================
    def build_axis(raw_map, axis_name, label, scale):
        """把某条独立日期轴的原始行 -> 主日历定长序列; 同时记录轴与换月点。"""
        if not raw_map:
            print(f"  {label}: 无可用数据, 跳过", flush=True)
            return 0
        lo, hi = all_dates[0], all_dates[-1]
        ds = sorted({r[0] for rows in raw_map.values() for r in rows})
        ds = [d for d in ds if lo <= d <= hi]           # 裁到主日历窗口
        if not ds:
            print(f"  {label}: 窗口内无数据, 跳过", flush=True)
            return 0
        axes[axis_name] = ds
        n_roll = 0
        for code, rows in sorted(raw_map.items()):
            rp = [d for d in roll_points(rows) if lo <= d <= hi]
            rolls[code] = rp
            n_roll += len(rp)
            m_ = {}
            for r in rows:
                m_[r[0]] = (float(r[1]), float(r[2]), float(r[3]),
                            float(r[4]), float(r[5] or 0))
            series[code] = resample_axis(ds, m_, all_dates, scale)
        print(f"  {label} 轴 {len(ds)} 天 ({ds[0]} ~ {ds[-1]}), "
              f"{len(raw_map)} 个标的, 换月跳空点 {n_roll} 个", flush=True)
        for code in sorted(raw_map):
            if rolls.get(code):
                print(f"      {code} 换月: {', '.join(rolls[code][:8])}"
                      f"{' ...' if len(rolls[code]) > 8 else ''}", flush=True)
        return len(raw_map)

    print("\n另类品种落盘 ...", flush=True)
    n_fu = build_axis(fu_raw, "FU", "期货 FU", 100)
    n_cr = build_axis(cr_raw, "CR", "数字资产 CR", 100)

    # 期货 meta (未抓到的降级为合成, 标「模拟历史」)
    fu_synth = []
    for code, name, ind, market, sym, lim in FUT_LIST:
        if code in series:
            meta.append([code, name, ind, market, lim, "FU"])
        else:
            base, vol = FUT_SYNTH.get(code, (560.0, 0.012))
            series[code] = gen_synth(code, base, vol, 0.0, all_dates, 100)
            meta.append([code, name, ind, market, lim, ""])
            synthetic.add(code)
            fu_synth.append(code)
    if fu_synth:
        print(f"  期货合成降级: {', '.join(fu_synth)}", flush=True)

    # 数字资产 meta (未抓到的降级为合成)
    cr_synth = []
    for code, name, ind, market, bsym, gpair, base, vol in CRY_LIST:
        if code in series:
            meta.append([code, name, ind, market, 0, "CR"])
        else:
            series[code] = gen_synth(code, base, vol, 0.0, all_dates, 100)
            meta.append([code, name, ind, market, 0, ""])
            synthetic.add(code)
            cr_synth.append(code)
    if cr_synth:
        print(f"  数字资产合成降级: {', '.join(cr_synth)}", flush=True)

    # 期权: 只落「标的 ETF」序列, 期权链运行时 BSM 生成(Q7 决定, 不落盘)
    for code, name, ind, market, und in OPT_LIST:
        if und in series:
            series[code] = list(series[und])
            meta.append([code, name, ind, market, 0, ""])
    n_opt = len([1 for c, *_ in OPT_LIST if c in series])

    # 私募/信托: 非净值型, 序列 = 应计单位净值(按 252 交易日/年线性累积)
    n_pm = 0
    for code, name, ind, market, annual in PM_PRODUCTS:
        arr = [0] * (len(all_dates) * 5)
        for i in range(len(all_dates)):
            iv = int(round((1.0 + annual * (i + 1) / 252.0) * 10000))
            b = i * 5
            arr[b] = arr[b + 1] = arr[b + 2] = arr[b + 3] = iv
            arr[b + 4] = 0
        series[code] = arr
        meta.append([code, name, ind, market, 0, ""])
        synthetic.add(code)
        n_pm += 1

    # 另类/结构性: 序列 = 挂钩标的的真实序列(收益规则在前端 game.js)
    n_alt = 0
    for code, name, ind, market, und in ALT_PRODUCTS:
        if und in series:
            series[code] = list(series[und])
            meta.append([code, name, ind, market, 0, ""])
            n_alt += 1
        else:
            print(f"  [warn] ALT 挂钩标的 {und} 缺失, 跳过 {code}", flush=True)

    print(f"  落盘: 期货 {n_fu} / 数字资产 {n_cr} / 期权标的 {n_opt} / "
          f"私募信托 {n_pm} / 另类 {n_alt}", flush=True)
    print(f"  独立日期轴: " + (", ".join(f"{k}={len(v)}天" for k, v in sorted(axes.items()))
                          if axes else "无"), flush=True)

    # ---- 合规财经 RSS -> 滚动新闻条 ----
    print("\n抓取财经 RSS ...", flush=True)
    news = fetch_news()
    print(f"  共 {len(news)} 条新闻", flush=True)

    # ---- 除权日历: 从真实(不复权)序列反推 ----
    #     原理: 数据为不复权, 除权跳空已真实存在于序列中。
    #     故 perShare 由跳空幅度反推, 使「现金红利 ≈ 除权价损」,
    #     既不重复压价, 也不产生无风险套利。
    dv = []
    for code in DIV_CODES:
        rows = result.get(code)
        if not rows:
            continue
        rows = sorted(rows, key=lambda r: r[0])
        for i in range(1, len(rows)):
            d = rows[i][0]
            try:
                pc = float(rows[i - 1][2])   # 前收盘
                o = float(rows[i][1])        # 今开
                h = float(rows[i][3])        # 最高
            except Exception:
                continue
            if pc <= 0:
                continue
            mm = int(d[5:7])
            gap = (o - pc) / pc
            # 分红集中在 4-8 月; 跳空 0.8%~3.5%; 且全日未收复前收盘
            if 4 <= mm <= 8 and -0.035 <= gap <= -0.008 and h <= pc:
                dv.append({"c": code, "d": d, "s": round(pc * (-gap), 4)})
    print(f"除权日历: {len(dv)} 个事件, 覆盖 {len({x['c'] for x in dv})} 个标的", flush=True)

    # ---- 输出 ----
    payload = {"m": meta, "d": all_dates, "s": series, "dv": dv,
               "syn": sorted(synthetic), "news": news,
               "ax": axes,          # 独立日期轴 {FU:[...], CR:[...]}
               "rol": rolls,        # 主力连续换月跳空点 {code:[date,...]}
               "fxu": fxu}          # 构建期 USD/CNY 在岸价(USDT->人民币折算率)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成 - 真实历史行情快照, 请勿手工修改 */\n")
        f.write(f"/* 生成时间: {time.strftime('%Y-%m-%d %H:%M:%S')} */\n")
        f.write("/* 数据源: 腾讯财经 / 东方财富 / 新浪财经 (均为公开接口) */\n")
        f.write("window.SNAPSHOT=")
        f.write(body)
        f.write(";\n")

    zone = _C(m[3] for m in meta)
    size = os.path.getsize(out_path)
    print(f"\n[OK] 输出 {out_path}")
    print(f"     体积 {size/1024/1024:.2f} MB, 标的 {len(meta)} 个")
    print(f"     分区: " + ", ".join(f"{k}={v}" for k, v in sorted(zone.items())))
    print(f"     交易日 {all_dates[0]} ~ {all_dates[-1]} ({len(all_dates)} 天)")
    print(f"     除权事件 {len(dv)} 条, 新闻 {len(news)} 条, 模拟序列 {len(synthetic)} 个")
    print(f"     独立日期轴 " + (", ".join(f"{k}={len(v)}天" for k, v in sorted(axes.items()))
                            if axes else "无")
          + f"; 换月跳空点 {sum(len(v) for v in rolls.values())} 个"
          + (f"; USD/CNY={fxu}" if fxu else ""))


if __name__ == "__main__":
    main()
