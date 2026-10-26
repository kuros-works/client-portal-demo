"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from "@/lib/project-status";

import { createProject, type ProjectFormState } from "./actions";

const initialState: ProjectFormState = { status: "idle" };

const selectClassName =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type ClientOption = {
  id: string;
  email: string;
};

export function ProjectForm({ clients }: { clients: ClientOption[] }) {
  const [state, formAction, pending] = useActionState(
    createProject,
    initialState,
  );

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name">案件名</Label>
        <Input id="project-name" name="name" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-client">お客様</Label>
        <select
          id="project-client"
          name="client_id"
          required
          defaultValue=""
          className={selectClassName}
        >
          <option value="" disabled>
            選んでください
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.email}
            </option>
          ))}
        </select>
        {clients.length === 0 && (
          <p className="text-sm text-muted-foreground">
            先にお客様を招待してください。
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-status">ステータス</Label>
        <select
          id="project-status"
          name="status"
          defaultValue=""
          className={selectClassName}
        >
          <option value="">
            初期値（{PROJECT_STATUS_LABELS.in_progress}）
          </option>
          {PROJECT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          案件名とお客様を入力してください。
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          作成に失敗しました。時間をおいて、もう一度お試しください。
        </p>
      )}
      {state.status === "created" && (
        <p className="text-sm">案件を作成しました。</p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "送信中…" : "案件を作成する"}
      </Button>
    </form>
  );
}
