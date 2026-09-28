/* ============================================================================
 * data/lang/en.js —— English dictionary（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * Same key set as zh.js; zh-CN is the authoritative baseline.
 * ========================================================================== */
window.I18N_DICT = window.I18N_DICT || {};
Object.assign(window.I18N_DICT, {
  'en-US': Object.assign(window.I18N_DICT['en-US'] || {}, {

    // —— Language self-names (invariant across UI languages) ——
    'lang.name.zh-CN': '中文',
    'lang.name.ja-JP': '日本語',
    'lang.name.en-US': 'English',
    'lang.name.ko-KR': '한국어',
    'meta.lang.zh-CN': '中文',
    'meta.lang.ja-JP': '日本語',
    'meta.lang.en-US': 'English',
    'meta.lang.ko-KR': '한국어',

    // —— Language switcher ——
    'lang.switch.label': 'Language',
    'lang.switch.title': 'Switch language',
    'lang.switch.hint': 'Switching language does not change brand marks',

    // —— Generic buttons ——
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.confirm': 'Confirm',
    'common.yes': 'Yes',
    'common.no': 'No',

    // —— Status badges ——
    'badge.replay': 'Replay',
    'badge.live': 'Live Sync',

    // —— Toasts ——
    'toast.langChanged': 'Language switched: {name}',

    // —— Plural example (en distinguishes .one / .other) ——
    'common.items.one': '{n} item',
    'common.items.other': '{n} items'
  })
});
