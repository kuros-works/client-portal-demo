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
        <Label htmlFor="email">お客様のメールアドレス</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="off"
          required
        />
        {state.status === "invalid" && (
          <p className="text-sm text-destructive">
            メールアドレスを正しく入力してください。
          </p>
        )}
        {state.status === "exists" && (
          <p className="text-sm text-destructive">
            このメールアドレスは、すでに登録されています。
          </p>
        )}
        {state.status === "error" && (
          <p className="text-sm text-destructive">
            登録に失敗しました。時間をおいて、もう一度お試しください。
          </p>
        )}
        {state.status === "invited" && (
          <p className="text-sm">
            お客様を登録しました。メールは送っていません。お客様はログイン画面からリンクを依頼できます。
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "送信中…" : "招待する"}
      </Button>
    </form>
  );
}
