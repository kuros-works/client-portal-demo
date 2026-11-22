"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { ingestResultLine } from "@/lib/ingest-status";

import { reingestProjectFile, type ReingestFormState } from "./actions";

const initialState: ReingestFormState = { status: "idle" };

export function FileReingestForm({ fileId }: { fileId: string }) {
  const [state, formAction, pending] = useActionState(
    reingestProjectFile,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="file_id" value={fileId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Ingesting…" : "Re-ingest"}
      </Button>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">Invalid file.</p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          File not found. It may have already been deleted.
        </p>
      )}
      {state.status === "done" && state.ingest && (
        <p
          className={
            state.ingest.status === "ready" ? "text-sm" : "text-sm text-destructive"
          }
        >
          {ingestResultLine(state.ingest)}
        </p>
      )}
    </form>
  );
}
