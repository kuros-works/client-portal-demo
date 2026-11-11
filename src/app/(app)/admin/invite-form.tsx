"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { inviteClient, type InviteState } from "./actions";

const initialState: InviteState = { status: "idle" };

export function InviteForm() {
  const [state, formAction, pending] = useActionState(
    inviteClient,
    initialState,
  );

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Client email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="off"
          required
        />
        {state.status === "invalid" && (
          <p className="text-sm text-destructive">
            Please enter a valid email address.
          </p>
        )}
        {state.status === "exists" && (
          <p className="text-sm text-destructive">
            A client with this email already exists.
          </p>
        )}
        {state.status === "error" && (
          <p className="text-sm text-destructive">
            We couldn&apos;t invite the client. Please try again later.
          </p>
        )}
        {state.status === "invited" && (
          <p className="text-sm">
            Client added. No email was sent. They can request a sign-in link
            from the sign-in page.
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Inviting…" : "Invite"}
      </Button>
    </form>
  );
}
