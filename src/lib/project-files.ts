export const PROJECT_FILES_BUCKET = "project-files";

// next.config.ts の bodySizeLimit（4mb）より少し小さくする
export const MAX_FILE_SIZE = 4_000_000;

// 上限の「4MB」と合わせて、1000 区切りで表示する
export function formatFileSize(bytes: number) {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
