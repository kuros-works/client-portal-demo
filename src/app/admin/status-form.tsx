"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  isProjectStatus,
} from "@/lib/project-status";

import { updateProjectStatus, type StatusFormState } from "./actions";

const initialState: StatusFormState = { status: "idle" };

export function StatusForm({
  projectId,
  status,
}: {
  projectId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateProjectStatus,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input type="hidden" name="project_id" value={projectId} />
        <select
          name="status"
          defaultValue={isProjectStatus(status) ? status : ""}
          aria-label="ステータス"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {PROJECT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {PROJECT_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "変更中…" : "変更"}
        </Button>
      </div>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          ステータスを正しく選んでください。
        </p>
      )}
      {state.status === "not_updated" && (
        <p className="text-sm text-destructive">
          更新されませんでした。案件が存在しないか、更新の権限がありません。
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          変更に失敗しました。時間をおいて、もう一度お試しください。
        </p>
      )}
      {state.status === "updated" && (
        <p className="text-sm">ステータスを変更しました。</p>
      )}
    </form>
  );
}
