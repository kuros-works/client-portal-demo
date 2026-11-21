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
          if (!window.confirm(`Are you sure you want to delete "${fileName}"?`)) {
            event.preventDefault();
          }
        }}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">Invalid file.</p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          File not found. It may have already been deleted.
        </p>
      )}
      {state.status === "not_deleted" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t delete the file. You don&apos;t have permission.
        </p>
      )}
      {/* 行は消えたが Storage の実体が残っている（お客様が直接読める可能性がある）。
          警告を見せるため、この場合だけ Action は一覧を更新しない（再読み込みで一覧から消える） */}
      {state.status === "storage_failed" && (
        <p role="alert" className="text-sm text-destructive">
          File removed from the list, but the stored copy could not be deleted.
          Remove it in Supabase Storage. Reload the page to update the list.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t delete the file. Please try again later.
        </p>
      )}
      {/* 成功すると一覧から行が消えるので、このフォームも消える */}
      {state.status === "deleted" && <p className="text-sm">File deleted.</p>}
    </form>
  );
}
