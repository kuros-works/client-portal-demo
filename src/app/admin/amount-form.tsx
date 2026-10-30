"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_AMOUNT_CENTS,
  MIN_AMOUNT_CENTS,
  centsToInputValue,
  formatCents,
} from "@/lib/project-amount";

import { updateProjectAmount, type AmountFormState } from "./actions";

const initialState: AmountFormState = { status: "idle" };

export function AmountForm({
  projectId,
  amount,
  paymentStatus,
}: {
  projectId: string;
  amount: number | null;
  paymentStatus: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateProjectAmount,
    initialState,
  );
  const [value, setValue] = useState(centsToInputValue(amount));
  const [prevAmount, setPrevAmount] = useState(amount);

  // Keep the input in sync when the server sends a new amount.
  if (amount !== prevAmount) {
    setPrevAmount(amount);
    setValue(centsToInputValue(amount));
  }

  const paid = paymentStatus === "paid";

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input type="hidden" name="project_id" value={projectId} />
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          name="amount"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="No invoice"
          aria-label="Amount (USD)"
          disabled={paid}
          className="w-32"
        />
        {paid ? (
          <span className="text-sm font-medium">Paid</span>
        ) : (
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {paid && amount !== null && (
        <p className="text-sm text-muted-foreground">
          {formatCents(amount)} was paid. The amount can no longer be changed.
        </p>
      )}
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          Please enter a valid amount, like 50.00 (up to{" "}
          {formatCents(MAX_AMOUNT_CENTS)}), or leave it empty for no invoice.
        </p>
      )}
      {state.status === "too_small" && (
        <p className="text-sm text-destructive">
          The minimum amount is {formatCents(MIN_AMOUNT_CENTS)}.
        </p>
      )}
      {state.status === "paid" && (
        <p className="text-sm text-destructive">
          This project is already paid, so the amount can&apos;t be changed.
        </p>
      )}
      {state.status === "not_updated" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t update the amount. The project may not exist, or you
          may not have permission.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t update the amount. Please try again later.
        </p>
      )}
      {state.status === "updated" && <p className="text-sm">Amount updated.</p>}
      {state.status === "cleared" && (
        <p className="text-sm">Amount cleared. No invoice.</p>
      )}
    </form>
  );
}
