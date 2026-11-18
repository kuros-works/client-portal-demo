"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DAILY_QUESTION_LIMIT, MAX_QUESTION_LENGTH } from "@/lib/ask";

import { askQuestion, type AskFormState } from "./actions";

const initialState: AskFormState = { status: "idle" };

const ERROR_MESSAGES: Partial<Record<AskFormState["status"], string>> = {
  invalid: "Please enter a question.",
  too_long: `Your question is too long. The limit is ${MAX_QUESTION_LENGTH} characters.`,
  not_found: "We couldn't find this project.",
  no_sources:
    "There's no information about this project yet, so I can't answer.",
  daily_limit: `You've reached today's limit of ${DAILY_QUESTION_LIMIT} questions. It resets at 00:00 UTC.`,
  rate_limited:
    "Too many requests right now. Please wait a minute and try again.",
  unavailable: "We couldn't answer right now. Please try again later.",
  error: "Something went wrong. Please try again.",
};

export function AskForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    askQuestion,
    initialState,
  );
  const [value, setValue] = useState("");

  const errorMessage = ERROR_MESSAGES[state.status];

  return (
    <form action={formAction} className="flex flex-col gap-2 p-4">
      <input type="hidden" name="project_id" value={projectId} />
      <label htmlFor={`question-${projectId}`} className="sr-only">
        Your question
      </label>
      <textarea
        id={`question-${projectId}`}
        name="question"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={MAX_QUESTION_LENGTH}
        rows={3}
        placeholder="Ask a question about this project."
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:opacity-50"
        readOnly={pending}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending} className="h-9">
          {pending ? "Thinking…" : "Ask"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {value.length} / {MAX_QUESTION_LENGTH}
        </span>
      </div>
      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
      {state.status === "answered" && state.answer && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted p-3">
          {/* 回答は文字として表示する（HTML としては解釈しない） */}
          <p className="whitespace-pre-wrap break-words text-sm">
            {state.answer}
          </p>
          {state.sources && state.sources.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Sources searched: {state.sources.join(", ")}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
