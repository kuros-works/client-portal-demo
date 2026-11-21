import "server-only";

import { extractText, getDocumentProxy } from "unpdf";

// PDF から文字を取り出す。取り込めない理由は、0009 の check 制約の種類だけを返す。
// 本文や例外のメッセージはログに出さない（呼んだ側が fileId と種類だけを残す）。

export const MAX_PDF_PAGES = 20;
export const MAX_PDF_TEXT_LENGTH = 50_000;
export const MIN_PDF_TEXT_LENGTH = 200;

export type PdfTextFailure = "not_pdf" | "too_many_pages" | "too_long" | "no_text" | "failed";

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: PdfTextFailure };

// "%PDF-" の 5 バイト
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function startsWithPdfMagic(data: Uint8Array) {
  return data.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => data[i] === byte);
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  // ブラウザが送る MIME は信用せず、中身の先頭で確かめる
  if (!startsWithPdfMagic(data)) {
    return { ok: false, reason: "not_pdf" };
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // PDF.js は渡したバッファを手放す（detach）ことがあるので、写しを渡す
    pdf = await getDocumentProxy(new Uint8Array(data));

    // ページ数は文字を取る前に確かめる（大きな PDF の解析に時間を使わない）
    const pages = pdf.numPages;
    if (pages > MAX_PDF_PAGES) {
      return { ok: false, reason: "too_many_pages" };
    }

    const { text: pageTexts } = await extractText(pdf, { mergePages: false });
    // ページの間は空行にする（splitIntoChunks が段落の区切りとして扱う）
    const text = pageTexts.map((page) => page.trim()).join("\n\n").trim();

    if (text.length > MAX_PDF_TEXT_LENGTH) {
      return { ok: false, reason: "too_long" };
    }
    if (text.length < MIN_PDF_TEXT_LENGTH) {
      return { ok: false, reason: "no_text" };
    }
    return { ok: true, text, pages };
  } catch {
    // 壊れた PDF・パスワード付きなど。種類だけを返す
    return { ok: false, reason: "failed" };
  } finally {
    if (pdf) {
      // この版の PDF.js では、PDFDocumentProxy に destroy() が無く、loadingTask のほうにある
      // （文書と worker の両方を片付ける）。後片付けの失敗で結果は変えない
      await pdf.loadingTask.destroy().catch(() => {});
    }
  }
}
