import { Badge } from "@/components/ui/badge";

// amount が null（請求なし）のときは何も出さない
export function PaymentBadge({
  amount,
  paymentStatus,
}: {
  amount: number | null;
  paymentStatus: string;
}) {
  if (amount === null) {
    return null;
  }
  if (paymentStatus === "paid") {
    return (
      <Badge className="rounded-sm bg-[#E4F7EB] text-[#007A34]">Paid</Badge>
    );
  }
  return (
    <Badge className="rounded-sm bg-[#FFF3E0] text-[#E65200]">Unpaid</Badge>
  );
}
