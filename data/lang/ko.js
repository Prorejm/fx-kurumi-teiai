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

    // —— 설정 · 시장 미시구조 (본 작업은 프레임워크 key 만 등록) ——
    'set.micro.name': '시장 미시구조',
    'set.micro.tag': '기본 켜짐',
    'set.micro.desc': '가격은 주문 흐름으로 체결·청산됩니다(호가 5단·체결 틱·Kyle λ). 끄면 가격은 「과거 × 교란」으로 엄격히 되돌아갑니다.',
    'set.micro.levelNote': '단계가 높을수록 큰 주문이 가격을 더 움직이며, 반동도 잦아집니다.',
    'set.microLevel.lite': '간이',
    'set.microLevel.std': '표준',
    'set.microLevel.hard': '하드코어',

    // —— 복수형 예시 ——
    'common.items.one': '{n}개',
    'common.items.other': '{n}개'
  })
});
