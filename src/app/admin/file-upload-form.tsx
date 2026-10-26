"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_FILE_SIZE } from "@/lib/project-files";

import { uploadProjectFile, type UploadFormState } from "./actions";

const initialState: UploadFormState = { status: "idle" };

export function FileUploadForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    uploadProjectFile,
    initialState,
  );
  // bodySizeLimit を超えると Action まで届かずにエラーになるので、送る前にも確かめる
  const [tooLarge, setTooLarge] = useState(false);

  function submit(formData: FormData) {
    const file = formData.get("file");
    if (file instanceof File && file.size > MAX_FILE_SIZE) {
      setTooLarge(true);
      return;
    }
    setTooLarge(false);
    formAction(formData);
  }

  const status = tooLarge ? "too_large" : state.status;

  return (
    <form action={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input type="hidden" name="project_id" value={projectId} />
        <Input
          type="file"
          name="file"
          required
          aria-label="アップロードするファイル"
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "送信中…" : "アップロード"}
        </Button>
      </div>
      {status === "invalid" && (
        <p className="text-sm text-destructive">ファイルを選んでください。</p>
      )}
      {status === "empty" && (
        <p className="text-sm text-destructive">空のファイルは送れません。</p>
      )}
      {status === "too_large" && (
        <p className="text-sm text-destructive">
          ファイルが大きすぎます（4MB まで）。
        </p>
      )}
      {status === "error" && (
        <p className="text-sm text-destructive">
          アップロードに失敗しました。時間をおいて、もう一度お試しください。
        </p>
      )}
      {status === "uploaded" && (
        <p className="text-sm">ファイルをアップロードしました。</p>
      )}
    </form>
  );
}
