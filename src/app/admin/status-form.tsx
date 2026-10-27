"use client";

import { useActionState, useState } from "react";

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
  const [value, setValue] = useState(isProjectStatus(status) ? status : "");
  const [prevStatus, setPrevStatus] = useState(status);

  // Keep the select in sync when the server sends a new status.
  if (status !== prevStatus) {
    setPrevStatus(status);
    setValue(isProjectStatus(status) ? status : "");
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input type="hidden" name="project_id" value={projectId} />
        <select
          name="status"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Status"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {PROJECT_STATUSES.map((option) => (
            <option key={option} value={option}>
              {PROJECT_STATUS_LABELS[option]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Updating…" : "Update"}
        </Button>
      </div>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          Please select a valid status.
        </p>
      )}
      {state.status === "not_updated" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t update the status. The project may not exist, or you
          may not have permission.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t update the status. Please try again later.
        </p>
      )}
      {state.status === "updated" && (
        <p className="text-sm">Status updated.</p>
      )}
    </form>
  );
}
