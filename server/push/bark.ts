// Keep the device key in Worker secrets; never put it in URLs or logs.
export async function sendBarkOrderCreated(runtime: Record<string, unknown>, variables: Record<string, string | number>) {
  const key = typeof runtime.BARK_DEVICE_KEY === "string" ? runtime.BARK_DEVICE_KEY.trim() : "";
  if (!key) return;
  try {
    const response = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_key: key, title: "有订单", body: `订单号：${variables.orderNo}`, group: "商城订单" }),
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
