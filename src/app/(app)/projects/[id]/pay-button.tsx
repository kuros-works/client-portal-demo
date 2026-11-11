"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/project-amount";

import { createCheckoutSession, type CheckoutFormState } from "./actions";

const initialState: CheckoutFormState = { status: "idle" };

export function PayButton({
  projectId,
  amount,
}: {
  projectId: string;
  amount: number;
}) {
  const [state, formAction, pending] = useActionState(
    createCheckoutSession,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="project_id" value={projectId} />
      <Button type="submit" disabled={pending} className="w-full md:w-auto">
        {pending ? "Redirecting…" : `Pay ${formatCents(amount)}`}
      </Button>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          Something went wrong. Please reload the page and try again.
        </p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t find this project.
        </p>
      )}
      {state.status === "unavailable" && (
        <p className="text-sm text-destructive">
          This project can&apos;t be paid for right now. Please reload the page.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t start the payment. Please try again later.
        </p>
      )}
    </form>
  );
}
