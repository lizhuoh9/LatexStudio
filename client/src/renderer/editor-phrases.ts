import { getLocale } from '../shared/i18n'

/** CodeMirror's own English phrase keys; these never touch document text or LaTeX completions. */
const phrases: ReadonlyArray<readonly [string, string, string]> = [
  ['Find', '查找', '찾기'], ['Replace', '替换', '바꾸기'], ['next', '下一处', '다음'],
  ['previous', '上一处', '이전'], ['all', '全部', '모두'], ['match case', '区分大小写', '대소문자 구분'],
  ['regexp', '正则表达式', '정규식'], ['by word', '全字匹配', '단어 단위'], ['replace', '替换', '바꾸기'],
  ['replace all', '全部替换', '모두 바꾸기'], ['close', '关闭', '닫기'], ['Search', '搜索', '검색'],
  ['No matches found', '没有匹配项', '일치하는 항목 없음'], ['go to line', '跳转到行', '줄로 이동'],
  ['Go to line', '跳转到行', '줄로 이동'], ['go', '跳转', '이동'], ['Fold line', '折叠此行', '줄 접기'],
  ['Unfold line', '展开此行', '줄 펼치기'], ['Folded lines', '已折叠的行', '접힌 줄'],
  ['to', '至', '부터'], ['folded code', '已折叠的代码', '접힌 코드'], ['unfold', '展开', '펼치기'],
  ['Control character', '控制字符', '제어 문자'], ['Selection deleted', '所选内容已删除', '선택 영역 삭제됨'],
  ['current match', '当前匹配项', '현재 일치 항목'], ['on line', '所在行', '줄'],
  ['replaced match on line $', '已替换第 $ 行的匹配项', '$줄의 일치 항목을 바꿨습니다'],
  ['replaced $ matches', '已替换 $ 个匹配项', '일치 항목 $개를 바꿨습니다'],
  ['Completions', '补全建议', '자동 완성 제안'], ['No completions', '没有补全建议', '자동 완성 제안 없음'],
  ['Match case', '区分大小写', '대소문자 구분'], ['Whole word', '全字匹配', '단어 단위'],
  ['Regular expression', '正则表达式', '정규식'], ['Previous match', '上一处', '이전 항목'], ['Next match', '下一处', '다음 항목'],
  ['Close', '关闭', '닫기'], ['Replace all', '全部替换', '모두 바꾸기'], ['Show or hide replace', '显示或隐藏替换', '바꾸기 표시 또는 숨기기'],
  ['No results', '无结果', '결과 없음'], ['Invalid pattern', '正则表达式无效', '잘못된 정규식']
]
export function editorPhrases(): Record<string, string> {
  const locale = getLocale()
  if (locale === 'en') return {}
  return Object.fromEntries(phrases.map(([key, zh, ko]) => [key, locale === 'ko' ? ko : zh]))
}
