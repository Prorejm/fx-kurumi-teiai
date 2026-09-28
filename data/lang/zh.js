/* ============================================================================
 * data/lang/zh.js —— 简体中文基准词典（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * 结构：window.I18N_DICT['zh-CN'] = { 'key': '译文', ... }（扁平 key-value）
 * 本文件仅含「框架级种子 key」（T01）；存量业务文案的抽取在 T05 完成。
 * zh-CN 为权威基准：其余语言文件应与本文件保持同一 key 集合。
 * 品牌名 / 标的代码 / 法律条文编号 不进词典（由 VERSION.brand 提供，永不翻译）。
 * ========================================================================== */
window.I18N_DICT = window.I18N_DICT || {};
Object.assign(window.I18N_DICT, {
  'zh-CN': Object.assign(window.I18N_DICT['zh-CN'] || {}, {

    // —— 语言自称（不随界面语言变化，各语言文件一致）——
    'lang.name.zh-CN': '中文',
    'lang.name.ja-JP': '日本語',
    'lang.name.en-US': 'English',
    'lang.name.ko-KR': '한국어',
    'meta.lang.zh-CN': '中文',
    'meta.lang.ja-JP': '日本語',
    'meta.lang.en-US': 'English',
    'meta.lang.ko-KR': '한국어',

    // —— 语言切换入口 ——
    'lang.switch.label': '语言',
    'lang.switch.title': '切换语言',
    'lang.switch.hint': '切换语言不改变品牌标识',

    // —— 通用按钮 ——
    'common.ok': '确定',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.confirm': '确认',
    'common.yes': '是',
    'common.no': '否',

    // —— 状态徽章 ——
    'badge.replay': '历史回放',
    'badge.live': '实盘同步',

    // —— toast / 提示 ——
    'toast.langChanged': '已切换语言：{name}',

    // —— 玩法设置 · 市场微观结构（增量四；本任务仅登记框架 key）——
    'set.micro.name': '市场微观结构',
    'set.micro.tag': '默认开启',
    'set.micro.desc': '价格由订单流撮合出清（盘口五档、逐笔成交、Kyle λ 价格冲击）。关闭后价格严格退回「历史 × 扰动」。',
    'set.micro.levelNote': '档位越高，你的大单越能拉动价格，反噬也越频繁。',
    'set.microLevel.lite': '简化',
    'set.microLevel.std': '标准',
    'set.microLevel.hard': '硬核',

    // —— 复数示例（中/日/韩同形，读 .other）——
    'common.items.one': '{n} 项',
    'common.items.other': '{n} 项'
  })
});
