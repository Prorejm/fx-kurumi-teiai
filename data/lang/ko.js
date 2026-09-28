/* ============================================================================
 * data/lang/ko.js —— 한국어 사전（共享文件，两版逐字节一致）
 * ----------------------------------------------------------------------------
 * key 집합은 zh.js 와 동일하며 zh-CN 이 기준입니다.
 * ========================================================================== */
window.I18N_DICT = window.I18N_DICT || {};
Object.assign(window.I18N_DICT, {
  'ko-KR': Object.assign(window.I18N_DICT['ko-KR'] || {}, {

    // —— 언어 자칭(인터페이스 언어와 무관) ——
    'lang.name.zh-CN': '中文',
    'lang.name.ja-JP': '日本語',
    'lang.name.en-US': 'English',
    'lang.name.ko-KR': '한국어',
    'meta.lang.zh-CN': '中文',
    'meta.lang.ja-JP': '日本語',
    'meta.lang.en-US': 'English',
    'meta.lang.ko-KR': '한국어',

    // —— 언어 전환 진입 ——
    'lang.switch.label': '언어',
    'lang.switch.title': '언어 전환',
    'lang.switch.hint': '언어를 전환해도 브랜드 표기는 변경되지 않습니다',

    // —— 범용 버튼 ——
    'common.ok': '확인',
    'common.cancel': '취소',
    'common.close': '닫기',
    'common.confirm': '확인',
    'common.yes': '예',
    'common.no': '아니오',

    // —— 상태 배지 ——
    'badge.replay': '과거 재생',
    'badge.live': '실시간 동기화',

    // —— 토스트 ——
    'toast.langChanged': '언어가 전환되었습니다: {name}',

    // —— 복수형 예시 ——
    'common.items.one': '{n}개',
    'common.items.other': '{n}개'
  })
});
