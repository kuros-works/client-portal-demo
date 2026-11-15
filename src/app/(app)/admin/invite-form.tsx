"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { inviteOwner, inviteStaff, type InviteState } from "./actions";

const initialState: InviteState = { status: "idle" };

const selectClassName =
  "h-9 w-full rounded-sm border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type OrganizationOption = {
  id: string;
  name: string;
};

function InviteMessages({
  state,
  invalidText,
}: {
  state: InviteState;
  invalidText: string;
}) {
  return (
    <>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">{invalidText}</p>
      )}
      {state.status === "exists" && (
        <p className="text-sm text-destructive">
          A user with this email already exists.
        </p>
      )}
      {state.status === "not_found" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t find this company. Please reload the page.
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
    </>
  );
}

// 新しい会社を作り、その会社のオーナーとして招待する
export function OwnerInviteForm() {
  const [state, formAction, pending] = useActionState(
    inviteOwner,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="owner-organization-name" className="text-sm font-medium">
          Company name
        </Label>
        <Input
          id="owner-organization-name"
          name="organization_name"
          autoComplete="off"
          required
          className="h-9"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="owner-email" className="text-sm font-medium">
          Owner email
        </Label>
        <Input
          id="owner-email"
          name="email"
          type="email"
          autoComplete="off"
          required
          className="h-9"
        />
      </div>
      <InviteMessages
        state={state}
        invalidText="Please enter a company name and a valid email address."
      />
      <Button type="submit" disabled={pending} className="h-9 w-full font-medium">
        {pending ? "Inviting…" : "Create company and invite owner"}
      </Button>
    </form>
  );
}

// 既存の会社に、スタッフとして招待する
export function StaffInviteForm({
  organizations,
}: {
  organizations: OrganizationOption[];
}) {
  const [state, formAction, pending] = useActionState(
    inviteStaff,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="staff-organization" className="text-sm font-medium">
          Company
        </Label>
        <select
          id="staff-organization"
          name="organization_id"
          required
          defaultValue=""
          className={selectClassName}
        >
          <option value="" disabled>
            Select a company
          </option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
        {organizations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Create a company first.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="staff-email" className="text-sm font-medium">
          Staff email
        </Label>
        <Input
          id="staff-email"
          name="email"
          type="email"
          autoComplete="off"
          required
          className="h-9"
        />
      </div>
      <InviteMessages
        state={state}
        invalidText="Please select a company and enter a valid email address."
      />
      <Button type="submit" disabled={pending} className="h-9 w-full font-medium">
        {pending ? "Inviting…" : "Invite staff"}
      </Button>
    </form>
  );
}
