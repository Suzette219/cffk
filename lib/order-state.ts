export const ORDER_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

export type OrderStatus = "PENDING" | "PAID" | "DELIVERED" | "CLOSED" | "FAILED";
export type PaymentStatus = "UNPAID" | "PAID" | "FAILED";

export type PaymentConfirmationOutcome = "CONFIRMED" | "ALREADY_PAID" | "NOT_PAYABLE";

export function paymentConfirmationOutcome(status: OrderStatus, paymentStatus: PaymentStatus): PaymentConfirmationOutcome {
  if (paymentStatus === "PAID") return "ALREADY_PAID";
  return status === "PENDING" && paymentStatus === "UNPAID" ? "CONFIRMED" : "NOT_PAYABLE";
}

export function canConfirmPayment(status: OrderStatus, paymentStatus: PaymentStatus) {
  return paymentConfirmationOutcome(status, paymentStatus) === "CONFIRMED";
}

export function orderStatusVariant(status: string) {
  switch (status) {
    case "DELIVERED": return "success";
    case "PAID": return "info";
    case "PENDING": return "warning";
    case "FAILED": return "destructive";
    default: return "secondary";
  }
}
