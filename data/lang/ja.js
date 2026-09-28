/* ============================================================================
 * data/lang/ja.js —— 日本語辞書（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * 结构 / key 集合与 zh.js 完全一致；zh-CN 为权威基准。
 * ========================================================================== */
window.I18N_DICT = window.I18N_DICT || {};
Object.assign(window.I18N_DICT, {
  'ja-JP': Object.assign(window.I18N_DICT['ja-JP'] || {}, {

    // —— 言語の自称（不随界面语言变化）——
    'lang.name.zh-CN': '中文',
    'lang.name.ja-JP': '日本語',
    'lang.name.en-US': 'English',
    'lang.name.ko-KR': '한국어',
    'meta.lang.zh-CN': '中文',
    'meta.lang.ja-JP': '日本語',
    'meta.lang.en-US': 'English',
    'meta.lang.ko-KR': '한국어',

    // —— 言語切り替え入口 ——
    'lang.switch.label': '言語',
    'lang.switch.title': '言語を切り替え',
    'lang.switch.hint': '言語を切り替えてもブランド表記は変わりません',

    // —— 汎用ボタン ——
    'common.ok': 'OK',
    'common.cancel': 'キャンセル',
    'common.close': '閉じる',
    'common.confirm': '確認',
    'common.yes': 'はい',
    'common.no': 'いいえ',

    // —— ステータスバッジ ——
    'badge.replay': 'ヒストリカル再生',
    'badge.live': 'ライブ同期',

    // —— トースト ——
    'toast.langChanged': '言語を切り替えました：{name}',

    // —— 複数形の例 ——
    'common.items.one': '{n} 件',
    'common.items.other': '{n} 件'
  })
});
