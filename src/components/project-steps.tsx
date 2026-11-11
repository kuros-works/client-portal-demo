import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  isProjectStatus,
} from "@/lib/project-status";

// 3段階の進み具合。今の段階までを primary、先をグレーの横線で示す（% は出さない）
export function ProjectSteps({ status }: { status: string }) {
  const current = isProjectStatus(status)
    ? PROJECT_STATUSES.indexOf(status)
    : -1;

  return (
    <ol
      className="grid grid-cols-3 gap-1"
      aria-label={
        current >= 0
          ? `Progress: ${PROJECT_STATUS_LABELS[PROJECT_STATUSES[current]]}`
          : "Progress"
      }
    >
      {PROJECT_STATUSES.map((step, index) => (
        <li key={step} className="flex flex-col gap-1">
          <span
            className={`h-0.5 rounded-full ${
              index <= current ? "bg-primary" : "bg-[#E2E4E9]"
            }`}
          />
          <span
            className={`text-xs ${
              index === current
                ? "font-medium text-foreground"
                : "font-normal text-muted-foreground"
            }`}
          >
            {PROJECT_STATUS_LABELS[step]}
          </span>
        </li>
      ))}
    </ol>
  );
}
