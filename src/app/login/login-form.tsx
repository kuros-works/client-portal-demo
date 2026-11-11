"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { sendMagicLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    sendMagicLink,
    initialState,
  );

  if (state.status === "sent") {
    return (
      <p className="text-sm">
        If an account exists for that email, we&apos;ve sent a sign-in link.
        Please check your inbox.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email" className="text-sm font-medium">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-9"
        />
        {state.status === "invalid" && (
          <p className="text-sm text-destructive">
            Please enter a valid email address.
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="h-9 w-full font-medium">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
