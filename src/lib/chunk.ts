// 案件メモを検索用に分割する、単純な分割処理。
// 空行で段落に分け、約 CHUNK_SIZE 文字になるまで段落を詰める。
// 2 つ目以降の chunk の頭には、直前の chunk の末尾 CHUNK_OVERLAP 文字を重ねる
// （そのため 1 つの chunk は最大で約 902 文字：重なり 100 + 区切りの改行 2 + 本文 800）。

export const MAX_NOTE_LENGTH = 10_000;
export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;

export function splitIntoChunks(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  // 1 つの段落が CHUNK_SIZE より長いときは、文字数で切る
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    for (let start = 0; start < paragraph.length; start += CHUNK_SIZE) {
      pieces.push(paragraph.slice(start, start + CHUNK_SIZE));
    }
  }

  // 段落（の断片）を CHUNK_SIZE に収まる範囲で詰める
  const bodies: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (current && joined.length > CHUNK_SIZE) {
      bodies.push(current);
      current = piece;
    } else {
      current = joined;
    }
  }
  if (current) bodies.push(current);

  // 2 つ目以降の頭に、直前の chunk の末尾を重ねる
  return bodies.map((body, index) =>
    index === 0
      ? body
      : `${bodies[index - 1].slice(-CHUNK_OVERLAP).trimStart()}\n\n${body}`,
  );
}
