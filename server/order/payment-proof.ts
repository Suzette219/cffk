import { and, eq, isNull } from "drizzle-orm";
import { createDrizzleDb } from "@/database/drizzle";
import { order } from "@/database/drizzle/schema";
import { appError } from "@/lib/app-error";
import { isManualAlipayOrder } from "@/lib/alipay-manual";
import { normalizeOrderEmail } from "@/lib/local-orders";
import { ORDER_PAYMENT_TIMEOUT_MS } from "@/lib/order-state";
import { ALIPAY_TRANSACTION_NO_PATTERN, PAYMENT_PROOF_MAX_BYTES } from "@/lib/payment-proof";

export type PaymentProofInput = { orderNo: string; email?: string; transactionNo?: string; screenshot?: string };

export function validatePaymentProof(input: PaymentProofInput) {
  const transactionNo = input.transactionNo?.trim() || null;
  const screenshot = input.screenshot || null;
  if (!transactionNo && !screenshot) appError("PAYMENT_PROOF_REQUIRED");
  if (transactionNo && !ALIPAY_TRANSACTION_NO_PATTERN.test(transactionNo)) appError("PAYMENT_PROOF_TRANSACTION_INVALID");
  if (screenshot) {
    if (screenshot.length > Math.ceil(PAYMENT_PROOF_MAX_BYTES / 3) * 4 + 23 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot)) appError("PAYMENT_PROOF_IMAGE_INVALID");
    let bytes: string;
    try { bytes = atob(screenshot.slice(23)); } catch { appError("PAYMENT_PROOF_IMAGE_INVALID"); }
    if (bytes.length > PAYMENT_PROOF_MAX_BYTES || bytes.length < 4 || bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216 || bytes.charCodeAt(2) !== 255 || bytes.charCodeAt(bytes.length - 2) !== 255 || bytes.charCodeAt(bytes.length - 1) !== 217) appError("PAYMENT_PROOF_IMAGE_INVALID");
  }
  return { transactionNo, screenshot };
}

export async function submitPaymentProof(database: D1Database, input: PaymentProofInput, userId: string | null) {
  const email = normalizeOrderEmail(input.email ?? "");
  const access = email ? and(isNull(order.ownerUserId), eq(order.contactType, "EMAIL"), eq(order.contactEmailNormalized, email)) : userId ? eq(order.ownerUserId, userId) : null;
  if (!access || !input.orderNo.trim()) appError("ORDER_NOT_FOUND");
  const [record] = await createDrizzleDb(database).select().from(order).where(and(eq(order.orderNo, input.orderNo.trim()), access)).limit(1);
  if (!record) appError("ORDER_NOT_FOUND");
  if (!isManualAlipayOrder(record)) appError("PAYMENT_CHANNEL_INVALID");
  const proof = validatePaymentProof(input);
  // A lost response can be retried without overwriting the evidence already submitted.
  const existing = await database.prepare("SELECT orderId FROM orderPaymentProof WHERE orderId = ?").bind(record.id).first();
  if (existing) return { submitted: true as const };
  const now = Date.now();
  let result;
  try {
    result = await database.prepare(`INSERT INTO orderPaymentProof (orderId, transactionNo, screenshot, createdAt)
      SELECT id, ?, ?, ? FROM \`order\` WHERE id = ? AND status = 'PENDING' AND paymentStatus = 'UNPAID' AND createdAt > ?
      ON CONFLICT(orderId) DO NOTHING`).bind(proof.transactionNo, proof.screenshot, now, record.id, now - ORDER_PAYMENT_TIMEOUT_MS).run();
  } catch (cause) {
    // D1 wraps constraint errors; use the unique value lookup instead of leaking SQL errors.
    if (proof.transactionNo && await database.prepare("SELECT orderId FROM orderPaymentProof WHERE transactionNo = ? AND orderId != ?").bind(proof.transactionNo, record.id).first()) appError("PAYMENT_PROOF_TRANSACTION_USED");
    throw cause;
  }
  if (result.meta.changes !== 1 && !await database.prepare("SELECT orderId FROM orderPaymentProof WHERE orderId = ?").bind(record.id).first()) appError("PAYMENT_PROOF_ORDER_EXPIRED");
  return { submitted: true as const };
}
