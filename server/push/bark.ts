// Keep the device key in Worker secrets; never log the outgoing Bark URL.
export async function sendBarkOrderCreated(runtime: Record<string, unknown>, variables: Record<string, string | number>) {
  const key = typeof runtime.BARK_DEVICE_KEY === "string" ? runtime.BARK_DEVICE_KEY.trim() : "";
  if (!key) return;
  try {
    const message = `有订单\n订单号：${variables.orderNo}`;
    const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(message)}`;
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("BARK_PUSH_FAILED");
    const result = await response.json() as { code?: number };
    if (result.code !== 200) throw new Error("BARK_PUSH_FAILED");
  } catch {
    // Suppress provider responses and request metadata that could contain the key.
    throw new Error("BARK_PUSH_FAILED");
  }
}
