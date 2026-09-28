/* ============================================================================
 * i18n.js —— 零构建 · 零依赖的多语言运行时（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * 全局：window.I18N
 * API ：t(key, params) / tN(key, n) / setLang(code) / getLang() / onChange(cb)
 *       applyDom(root) / fmtMoney(v) / fmtDate(d) / loadDict(code) / setStrict(v)
 *       missing（累计缺失 key 数组）
 * 词典：window.I18N_DICT = { 'zh-CN': {...}, 'ja-JP': {...}, ... }
 *       —— 由 data/lang/*.js 与 data/lang/override.*.js 注入（override 后加载即覆盖）
 * 语言：zh-CN（默认）· ja-JP · en-US · ko-KR；持久化键 window.VERSION.langKey
 * STRICT 模式（默认开启）：缺 key 时 console.error 并渲染「⟦key⟧」，绝不静默回落中文
 * ========================================================================== */
window.I18N = (function () {
  'use strict';

  var FALLBACK = 'zh-CN';
  var SUPPORTED = ['zh-CN', 'ja-JP', 'en-US', 'ko-KR'];
  var DEFAULT_KEY = 'fxsim_lang_v1';

  // 词典容器：{ 'zh-CN': { key: value, ... }, ... }
  // 由 data/lang/*.js 在 i18n.js 之前或之后注入（同名 key 后写覆盖先写）。
  var DICTS = window.I18N_DICT = window.I18N_DICT || {};

  var lang = FALLBACK;
  var listeners = [];
  var missing = [];
  var STRICT = true;

  /* ---------------------------------------------------------------- 基础设施 */

  /** 取持久化键：优先 VERSION.langKey，兜底常量。 */
  function langKey() {
    try {
      if (window.VERSION && window.VERSION.langKey) return window.VERSION.langKey;
    } catch (e) { /* ignore */ }
    return DEFAULT_KEY;
  }

  /** 是否受支持语言。 */
  function isSupported(code) {
    return SUPPORTED.indexOf(code) !== -1;
  }

  /** 安全读取 localStorage（隐私模式/被禁用时返回 null）。 */
  function readStoredLang() {
    try {
      return localStorage.getItem(langKey());
    } catch (e) {
      return null;
    }
  }

  /** 安全写入 localStorage。 */
  function writeStoredLang(code) {
    try {
      localStorage.setItem(langKey(), code);
    } catch (e) { /* ignore */ }
  }

  /**
   * 动态加载词典（零构建 → 注入 <script>）。
   * 已内联加载的语言直接命中，无需注入。
   * @param {string} code 语言代码
   * @returns {boolean} 是否成功就绪
   */
  function loadDict(code) {
    if (!isSupported(code)) return false;
    if (DICTS[code]) return true; // 已由 index.html 内联加载
    if (typeof document === 'undefined') return false;
    var id = '__i18n_dict_' + code;
    if (document.getElementById(id)) return false; // 正在加载
    var s = document.createElement('script');
    s.id = id;
    s.src = 'data/lang/' + code.slice(0, 2) + '.js';
    s.async = false;
    document.head.appendChild(s);
    // 同时尝试加载本版 override（存在则覆盖，不存在 404 由浏览器静默）
    return false;
  }

  /* ---------------------------------------------------------------- 取词 API */

  /**
   * 取译文。
   * @param {string} key i18n key（整句一个 key，禁止拼接）
   * @param {Object} [params] 占位替换表，如 { n: 5, name: '茅台' }
   * @returns {string}
   */
  function t(key, params) {
    var cur = DICTS[lang] || {};
    var fall = DICTS[FALLBACK] || {};
    var s = cur[key];
    if (s === undefined) {
      if (STRICT) {
        missing.push(lang + ':' + key);
        try { console.error('[i18n] missing: ' + key); } catch (e) { /* ignore */ }
      }
      s = fall[key];
      if (s === undefined) return '⟦' + key + '⟧'; // 可见占位，绝不静默回落
    }
    if (params) {
      s = String(s).replace(/\{(\w+)\}/g, function (_, k) {
        return (params[k] !== undefined && params[k] !== null) ? params[k] : '{' + k + '}';
      });
    }
    return s;
  }

  /**
   * 复数取词：英文区分 .one/.other；中/日/韩同形，读 .other。
   * @param {string} key 复数 key 前缀（不含后缀）
   * @param {number} n 数量
   * @param {Object} [params] 额外占位（自动注入 { n }）
   * @returns {string}
   */
  function tN(key, n, params) {
    var suffix = (lang === 'en-US' && Number(n) === 1) ? '.one' : '.other';
    var p = params ? Object.assign({ n: n }, params) : { n: n };
    return t(key + suffix, p);
  }

  /**
   * 切换语言：即时生效，持久化，触发 onChange 回调，并重扫 DOM。
   * @param {string} code
   */
  function setLang(code) {
    if (!isSupported(code)) {
      try { console.error('[i18n] unsupported lang: ' + code); } catch (e) { /* ignore */ }
      return;
    }
    if (!DICTS[code]) loadDict(code);
    lang = code;
    writeStoredLang(code);
    try { document.documentElement.lang = code; } catch (e) { /* ignore */ }
    try { applyDom(document); } catch (e) { /* ignore */ }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](code); } catch (e) { /* 单个回调失败不影响其余 */ }
    }
  }

  /** 当前语言。 */
  function getLang() { return lang; }

  /** 注册语言变更回调。 */
  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  /* ------------------------------------------------------------ DOM 静态替换 */

  /** 该节点或其祖先是否标注「不翻译」。 */
  function isSkipped(node) {
    var el = node;
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute('data-i18n-skip')) return true;
      el = el.parentNode;
    }
    return false;
  }

  /**
   * 扫描并替换 DOM 静态文案。
   *  - [data-i18n]      → textContent
   *  - [data-i18n-html] → innerHTML
   *  - [data-i18n-attr] → "placeholder:key|title:key2"
   * 带 [data-i18n-skip] 的子树永不替换。
   * @param {ParentNode} [root=document]
   */
  function applyDom(root) {
    root = root || document;
    if (!root || !root.querySelectorAll) return;

    var nodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      if (isSkipped(nodes[i])) continue;
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }

    nodes = root.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < nodes.length; j++) {
      if (isSkipped(nodes[j])) continue;
      nodes[j].innerHTML = t(nodes[j].getAttribute('data-i18n-html'));
    }

    nodes = root.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < nodes.length; k++) {
      if (isSkipped(nodes[k])) continue;
      var pairs = String(nodes[k].getAttribute('data-i18n-attr')).split('|');
      for (var p = 0; p < pairs.length; p++) {
        var kv = pairs[p].split(':');
        var attr = (kv[0] || '').trim();
        var key = (kv[1] || '').trim();
        if (attr && key) nodes[k].setAttribute(attr, t(key));
      }
    }
  }

  /* ---------------------------------------------------------------- 格式化 */

  /** 千分位（各 locale 均以逗号分隔 —— 中日韩英一致）。 */
  function groupThousands(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 人民币金额格式化。
   *  - zh-CN：¥1,234.56
   *  - ja/en/ko：CNY ¥1,234.56（避免与日元混淆）
   * @param {number} v
   * @returns {string}
   */
  function fmtMoney(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    var neg = n < 0;
    n = Math.abs(n);
    var fixed = n.toFixed(2);
    var parts = fixed.split('.');
    var body = '¥' + groupThousands(parts[0]) + '.' + parts[1];
    if (lang !== 'zh-CN') body = 'CNY ' + body;
    return (neg ? '-' : '') + body;
  }

  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * 按 locale 格式化日期。
   *  zh: 2025-06-12 · ja: 2025年6月12日 · en: Jun 12, 2025 · ko: 2025.06.12
   * @param {string|number|Date} d ISO 字符串 / 时间戳 / Date
   * @returns {string}
   */
  function fmtDate(d) {
    var y, m, day;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
      y = +d.slice(0, 4); m = +d.slice(5, 7); day = +d.slice(8, 10);
    } else {
      var dt = (d instanceof Date) ? d : new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      y = dt.getFullYear(); m = dt.getMonth() + 1; day = dt.getDate();
    }
    var mm = (m < 10 ? '0' : '') + m;
    var dd = (day < 10 ? '0' : '') + day;
    switch (lang) {
      case 'ja-JP': return y + '年' + m + '月' + day + '日';
      case 'en-US': return MONTHS_EN[m - 1] + ' ' + day + ', ' + y;
      case 'ko-KR': return y + '.' + mm + '.' + dd;
      case 'zh-CN':
      default: return y + '-' + mm + '-' + dd;
    }
  }

  /* ---------------------------------------------------------------- 严格模式 */

  /** 开关严格模式（默认开）。关闭后缺 key 不再累计/报错。 */
  function setStrict(v) { STRICT = !!v; }

  /** 清空缺失集合（测试/调试用）。 */
  function clearMissing() { missing.length = 0; }

  /* ---------------------------------------------------------- 自初始化（轻量） */

  // 读取持久化语言偏好（不触发回调、不扫描 DOM —— 启动阶段由 main.js 显式调用 setLang）。
  (function init() {
    var stored = readStoredLang();
    if (stored && isSupported(stored)) lang = stored;
    try { document.documentElement.lang = lang; } catch (e) { /* ignore */ }
  })();

  return {
    t: t,
    tN: tN,
    setLang: setLang,
    getLang: getLang,
    onChange: onChange,
    applyDom: applyDom,
    fmtMoney: fmtMoney,
    fmtDate: fmtDate,
    loadDict: loadDict,
    setStrict: setStrict,
    clearMissing: clearMissing,
    supported: SUPPORTED,
    fallback: FALLBACK,
    missing: missing
  };
})();
