export const PROJECT_STATUSES = [
  "in_progress",
  "in_review",
  "delivered",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  in_progress: "In progress",
  in_review: "In review",
  delivered: "Delivered",
};

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return PROJECT_STATUSES.includes(value as ProjectStatus);
}
