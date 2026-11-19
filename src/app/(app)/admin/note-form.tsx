"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { MAX_NOTE_LENGTH } from "@/lib/chunk";

import { saveProjectNote, type NoteFormState } from "./actions";

const initialState: NoteFormState = { status: "idle" };

export function NoteForm({
  projectId,
  body,
}: {
  projectId: string;
  body: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    saveProjectNote,
    initialState,
  );
  const [value, setValue] = useState(body ?? "");
  const [prevBody, setPrevBody] = useState(body);

  // Keep the text in sync when the server sends a new note.
  if (body !== prevBody) {
    setPrevBody(body);
    setValue(body ?? "");
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <label
        htmlFor={`note-${projectId}`}
        className="text-sm font-medium"
      >
        Project note
      </label>
      <textarea
        id={`note-${projectId}`}
        name="body"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={MAX_NOTE_LENGTH}
        rows={5}
        placeholder="Write a note about this project."
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:opacity-50"
        readOnly={pending}
      />
      <p className="text-xs text-muted-foreground">
        Only write what the client may see. This note is used to answer
        questions about the project.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending} className="h-9">
          {pending ? "Saving…" : "Save note"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {value.length} / {MAX_NOTE_LENGTH}
        </span>
      </div>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          Please write a note before saving.
        </p>
      )}
      {state.status === "too_long" && (
        <p className="text-sm text-destructive">
          The note is too long. The limit is {MAX_NOTE_LENGTH.toLocaleString("en-US")}{" "}
          characters.
        </p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t find this project. It may have been removed.
        </p>
      )}
      {state.status === "rate_limited" && (
        <p className="text-sm text-destructive">
          Too many requests right now. Please wait a little and try again.
        </p>
      )}
      {state.status === "embedding_failed" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t process the note, so nothing was saved. Please try
          again later.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t save the note. Please try again.
        </p>
      )}
      {state.status === "saved" && <p className="text-sm">Note saved.</p>}
    </form>
  );
}
