// 案件への質問（RAG）の共通の定数。client のフォームからも読めるよう、server-only は付けない。

// 質問の最大文字数（Server Action と textarea の maxLength で共有）
export const MAX_QUESTION_LENGTH = 500;

// 検索で取り出し、Claude に渡す chunk の数
// （1 chunk は最大で約 900 文字。match_project_chunks は DB 側でも 1〜10 に収める）
export const MATCH_COUNT = 5;
