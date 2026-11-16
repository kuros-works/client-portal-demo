"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from "@/lib/project-status";

import { createProject, type ProjectFormState } from "./actions";

const initialState: ProjectFormState = { status: "idle" };

const selectClassName =
  "h-9 w-full rounded-sm border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type OrganizationChoice = {
  id: string;
  label: string;
};

export function ProjectForm({
  organizations,
}: {
  organizations: OrganizationChoice[];
}) {
  const [state, formAction, pending] = useActionState(
    createProject,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name" className="text-sm font-medium">Project name</Label>
        <Input id="project-name" name="name" required className="h-9" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-organization" className="text-sm font-medium">Company</Label>
        <select
          id="project-organization"
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
              {organization.label}
            </option>
          ))}
        </select>
        {organizations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Create a company and invite its owner first.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-status" className="text-sm font-medium">Status</Label>
        <select
          id="project-status"
          name="status"
          defaultValue=""
          className={selectClassName}
        >
          <option value="">
            Default ({PROJECT_STATUS_LABELS.in_progress})
          </option>
          {PROJECT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {state.status === "invalid" && (
        <p className="text-sm text-destructive">
          Please enter a project name and select a company.
        </p>
      )}
      {state.status === "no_owner" && (
        <p className="text-sm text-destructive">
          This company has no owner yet. Invite an owner first.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-sm text-destructive">
          We couldn&apos;t create the project. Please try again later.
        </p>
      )}
      {state.status === "created" && (
        <p className="text-sm">Project created.</p>
      )}
      <Button type="submit" disabled={pending} className="h-9 w-full font-medium">
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
