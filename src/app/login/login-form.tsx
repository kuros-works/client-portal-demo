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
        登録済みのメールアドレスであれば、ログイン用のリンクを送りました。メールをご確認ください。
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">メールアドレス</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        {state.status === "invalid" && (
          <p className="text-sm text-destructive">
            メールアドレスを正しく入力してください。
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "送信中…" : "ログインリンクを送る"}
      </Button>
    </form>
  );
}
