export const PAYMENT_PROOF_MAX_BYTES = 200 * 1024;
export const ALIPAY_TRANSACTION_NO_PATTERN = /^\d{20,64}$/;

export type PaymentProofSummary = { transactionNo: string | null; hasScreenshot: boolean; createdAt: Date };
