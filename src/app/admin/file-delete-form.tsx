"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { deleteProjectFile, type DeleteFileFormState } from "./actions";

const initialState: DeleteFileFormState = { status: "idle" };

export function FileDeleteForm({
  fileId,
  fileName,
}: {
  fileId: string;
  fileName: string;
}) {
  const [state, formAction, pending] = useActionState(
    deleteProjectFile,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="file_id" value={fileId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={(event) => {
          if (!window.confirm(`「${fileName}」を本当に削除しますか？`)) {
            event.preventDefault();
          }
        }}
      >
        {pending ? "削除中…" : "削除"}
      </Button>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">ファイルの指定が正しくありません。</p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          ファイルが見つかりません。すでに削除された可能性があります。
        </p>
      )}
      {state.status === "not_deleted" && (
        <p className="text-sm text-destructive">
          削除されませんでした。削除の権限がありません。
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          削除に失敗しました。時間をおいて、もう一度お試しください。
        </p>
      )}
      {/* 成功すると一覧から行が消えるので、このフォームも消える */}
      {state.status === "deleted" && <p className="text-sm">削除しました。</p>}
    </form>
  );
}
