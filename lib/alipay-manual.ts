import type { JsonFormFieldDefinition } from "./json-form-values";

export function isCollectionQrImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const text = value.trim();
  if (/[\\\s]/.test(text) || [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const base = "https://collection-image.invalid";
    const url = new URL(text, base);
    if (text.startsWith("/")) return !text.startsWith("//") && url.origin === base;
    return /^https?:\/\//i.test(text) && !url.username && !url.password;
  } catch { return false; }
}

export function isManualAlipayOrder(record: { paymentProvider: string; paymentChannel: string | null | undefined }) {
  return record.paymentProvider === "ALIPAY" && record.paymentChannel === "manual";
}

export function isManualOnlyAlipay(values: Record<string, unknown>) {
  return Array.isArray(values.modes) && values.modes.length === 1 && values.modes[0] === "manual";
}

export function alipayFormFields(fields: JsonFormFieldDefinition[], values: Record<string, unknown>) {
  const manual = Array.isArray(values.modes) && values.modes.includes("manual");
  return fields.filter((field) => {
    if (field.key === "modes") return true;
    if (field.key === "collectionQrImage") return manual;
    return !isManualOnlyAlipay(values);
  }).map((field) => field.key === "collectionQrImage" ? { ...field, required: true } : field);
}
