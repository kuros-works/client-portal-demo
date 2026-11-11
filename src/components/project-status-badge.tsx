import { Badge } from "@/components/ui/badge";
import {
  PROJECT_STATUS_LABELS,
  isProjectStatus,
  type ProjectStatus,
} from "@/lib/project-status";

// 薄い背景＋濃い文字
const STATUS_COLORS: Record<ProjectStatus, string> = {
  in_progress: "bg-[#E6F2FE] text-[#4656B9]",
  in_review: "bg-[#E0F2F1] text-[#00695C]",
  delivered: "bg-[#E4F7EB] text-[#007A34]",
};

export function ProjectStatusBadge({ status }: { status: string }) {
  if (!isProjectStatus(status)) {
    return null;
  }
  return (
    <Badge className={`rounded-sm ${STATUS_COLORS[status]}`}>
      {PROJECT_STATUS_LABELS[status]}
    </Badge>
  );
}
