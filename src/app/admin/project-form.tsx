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
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export type ClientOption = {
  id: string;
  email: string;
};

export function ProjectForm({ clients }: { clients: ClientOption[] }) {
  const [state, formAction, pending] = useActionState(
    createProject,
    initialState,
  );

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name">Project name</Label>
        <Input id="project-name" name="name" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-client">Client</Label>
        <select
          id="project-client"
          name="client_id"
          required
          defaultValue=""
          className={selectClassName}
        >
          <option value="" disabled>
            Select a client
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.email}
            </option>
          ))}
        </select>
        {clients.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Invite a client first.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-status">Status</Label>
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
          Please enter a project name and select a client.
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
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
