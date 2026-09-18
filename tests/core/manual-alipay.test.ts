import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
// @ts-expect-error Tests use Bun without its global type package.
import { test } from "bun:test";
import { alipayFormFields, DEFAULT_ALIPAY_COLLECTION_IMAGE } from "../../lib/alipay-manual";
import { canonicalizeAlipayParameters } from "../../lib/payment-utils";
import { getJsonFormErrors } from "../../lib/json-form-values";
import { mergePaymentProviderConfig, mergePaymentUrls } from "../../server/payment/admin.telefunc";
import { paymentProviderDefinitions, parseProviderConfig } from "../../server/payment/registry";
import { createProviderAdapter } from "../../server/payment/providers";
import { PaymentFlowService } from "../../server/payment/flow-service";
import { PaymentCallbackService } from "../../server/payment/callback-service";
import { reconcilePendingAlipayPayments } from "../../server/payment/reconciliation-service";
import { closeExpiredPendingOrders, closePendingOrder } from "../../server/order/service";
import { createTestDatabase } from "../helpers/sqlite-d1";

const config = { schemaVersion: 1, modes: ["manual"], collectionQrImage: "https://shop.example/collection.png" };

test("personal QR configuration supports custom images without API credentials or callbacks", () => {
  const values = { modes: config.modes, collectionQrImage: config.collectionQrImage };
  const json = mergePaymentProviderConfig({ provider: "ALIPAY", values });
  const parsed = parseProviderConfig("ALIPAY", json);
  assert.deepEqual(paymentProviderDefinitions.ALIPAY.getChannels(parsed), ["manual"]);
  assert.deepEqual(mergePaymentUrls("ALIPAY", null, values), {});
  assert.deepEqual(getJsonFormErrors(alipayFormFields(paymentProviderDefinitions.ALIPAY.fields, values), values), {});
  for (const image of ["javascript:alert(1)", "data:image/png;base64,a", "//evil.example/qr.png", "/\\evil.example/qr.png", "https://user:pass@example.com/qr.png"]) {
    assert.throws(() => parseProviderConfig("ALIPAY", JSON.stringify({ ...config, collectionQrImage: image })));
  }
  assert.throws(() => parseProviderConfig("ALIPAY", JSON.stringify({ ...config, modes: ["manual", "web"] })));
  assert.throws(() => parseProviderConfig("ALIPAY", JSON.stringify({ ...config, modes: [] })));
  const localValues = { ...values, collectionQrImage: "/media/proxy/media/collection.png" };
  assert.doesNotThrow(() => mergePaymentProviderConfig({ provider: "ALIPAY", values: localValues }));
  assert.deepEqual(getJsonFormErrors(alipayFormFields(paymentProviderDefinitions.ALIPAY.fields, localValues), localValues), {});
});

test("personal QR defaults to the bundled image when the image setting is absent or blank", async () => {
  for (const collectionQrImage of [undefined, "", "   "]) {
    const values = { modes: ["manual"], ...(collectionQrImage === undefined ? {} : { collectionQrImage }) };
    const json = mergePaymentProviderConfig({ provider: "ALIPAY", values });
    assert.deepEqual(getJsonFormErrors(alipayFormFields(paymentProviderDefinitions.ALIPAY.fields, values), values), {});
    const adapter = createProviderAdapter("ALIPAY", JSON.parse(json));
    const payment = await adapter.create({ orderNo: "ORD-BUILTIN", amount: 1000, subject: "Order", channel: "manual", notifyUrl: "", returnUrl: "" });
    assert.equal(payment.qrImageUrl, DEFAULT_ALIPAY_COLLECTION_IMAGE);
  }
});

test("personal QR adapter returns the image and never treats a callback as paid", async () => {
  const adapter = createProviderAdapter("ALIPAY", config);
  assert.deepEqual(await adapter.create({ orderNo: "ORD-1", amount: 1000, subject: "Order", channel: "manual", notifyUrl: "", returnUrl: "" }), { mode: "qr", qrImageUrl: config.collectionQrImage, paymentOrderNo: "ORD-1" });
  assert.equal((await adapter.verify({ payload: { out_trade_no: "ORD-1", total_amount: "10.00", trade_status: "TRADE_SUCCESS" } })).verified, false);
  assert.equal((await adapter.query!({ orderNo: "ORD-1", amount: 1000 })).status, "PENDING");
  await assert.rejects(() => createProviderAdapter("ALIPAY", { ...config, modes: ["web"], baseUrl: "https://openapi.alipay.com", appId: "a", sellerId: "s", privateKey: "key", alipayPublicKey: "key", notifyUrl: "", returnUrl: "" }).create({ orderNo: "ORD-1", amount: 1000, subject: "Order", channel: "manual", notifyUrl: "", returnUrl: "" }), /PAYMENT_CHANNEL_INVALID/);
});

function fixture(price = 1000) {
  const context = createTestDatabase();
  const now = Date.now();
  context.sqlite.query("INSERT INTO siteSetting (id, siteName, siteUrl, registrationEnabled, timezone, createdAt, updatedAt) VALUES (1, 'Shop', 'https://shop.example', 1, 'Asia/Shanghai', ?, ?)").run(now, now);
  context.sqlite.query("INSERT INTO paymentProvider (provider, name, isEnabled, sort, configJson, createdAt, updatedAt) VALUES ('ALIPAY', '支付宝', 1, 0, ?, ?, ?)").run(JSON.stringify(config), now, now);
  context.sqlite.query("INSERT INTO product_v2 (id, name, slug, status, sort, createdAt, updatedAt) VALUES (1, 'Product', 'manual-test', 'ACTIVE', 0, ?, ?)").run(now, now);
  context.sqlite.query("INSERT INTO productSku (id, productId, name, price, status, deliveryType, fixedDeliveryContent, minBuy, maxBuy, sort, createdAt, updatedAt) VALUES (1, 1, 'Default', ?, 'ACTIVE', 'FIXED_CARD', 'LICENSE-1', 1, 1, 0, ?, ?)").run(price, now, now);
  return { ...context, flow: new PaymentFlowService(context.database) };
}
const input = { productId: 1, productSkuId: 1, quantity: 1, paymentProvider: "ALIPAY" as const, paymentChannel: "manual" as const, contactType: "EMAIL" as const, contactValue: "buyer@example.com" };

test("personal QR purchase resumes, waits for confirmation, and delivers only once", async () => {
  const context = fixture();
  try {
    const { flow, sqlite, database } = context;
    const created = await flow.create(input, null);
    assert.equal(created.payment?.qrImageUrl, config.collectionQrImage);
    const record = sqlite.query("SELECT id FROM `order` WHERE orderNo = ?").get(created.orderNo) as { id: number };
    await assert.rejects(() => flow.resume(created.orderNo, null, "other@example.com"), /ORDER_NOT_FOUND/);
    assert.equal((await flow.resume(created.orderNo, null, input.contactValue)).payment?.qrImageUrl, config.collectionQrImage);
    assert.equal((await flow.query(created.orderNo, null, input.contactValue))?.paymentStatus, "UNPAID");
    assert.equal((await reconcilePendingAlipayPayments(database)).scanned, 0);
    // Manual orders remain available for reconciliation by the merchant, even after the normal timeout.
    assert.equal((await closeExpiredPendingOrders(database, new Date(Date.now() + 86400000))).closed, 0);
    for (const source of ["QUERY", "CALLBACK", "SCHEDULED_QUERY", "ZERO_AMOUNT"]) {
      await assert.rejects(() => flow.confirm(created.orderNo, source, 1000), /PAYMENT_MANUAL_CONFIRM_REQUIRED/);
    }
    await assert.rejects(() => flow.confirmManual(record.id, "10.00", ""), /ADMIN_ACCESS_REQUIRED/);
    await assert.rejects(() => flow.confirmManual(record.id, "1.00", "admin-1"), /PAYMENT_AMOUNT_MISMATCH/);
    await flow.confirmManual(record.id, "10.00", "admin-1");
    await flow.confirmManual(record.id, "10.00", "admin-1");
    assert.deepEqual(sqlite.query("SELECT paymentStatus, deliveryStatus FROM `order` WHERE id = ?").get(record.id), { paymentStatus: "PAID", deliveryStatus: "DELIVERED" });
    assert.equal((sqlite.query("SELECT COUNT(*) AS total FROM orderDelivery WHERE orderId = ?").get(record.id) as { total: number }).total, 1);
    const log = sqlite.query("SELECT rawPayload FROM paymentLog WHERE orderId = ? AND eventType = 'CONFIRM'").get(record.id);
    assert.ok(log);
    assert.match((log as { rawPayload: string }).rawPayload, /ADMIN_MANUAL:admin-1/);
  } finally { context.close(); }
});

test("closed and non-manual orders cannot be manually confirmed", async () => {
  const context = fixture();
  try {
    const created = await context.flow.create(input, null);
    const record = context.sqlite.query("SELECT id FROM `order` WHERE orderNo = ?").get(created.orderNo) as { id: number };
    await closePendingOrder(context.database, record.id);
    await assert.rejects(() => context.flow.confirmManual(record.id, "10.00", "admin-1"), /PAYMENT_MANUAL_ORDER_NOT_PAYABLE/);
    context.sqlite.query("UPDATE `order` SET paymentChannel = 'web' WHERE id = ?").run(record.id);
    await assert.rejects(() => context.flow.confirmManual(record.id, "10.00", "admin-1"), /PAYMENT_MANUAL_ORDER_REQUIRED/);
  } finally { context.close(); }
});

test("zero-amount purchases still complete without manual payment", async () => {
  const context = fixture(0);
  try { assert.equal((await context.flow.create(input, null)).paymentStatus, "PAID"); }
  finally { context.close(); }
});

test("even a correctly signed API callback cannot pay a manual order in mixed mode", async () => {
  const context = fixture();
  try {
    const created = await context.flow.create(input, null);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    context.sqlite.query("UPDATE paymentProvider SET configJson = ? WHERE provider = 'ALIPAY'").run(JSON.stringify({ ...config, modes: ["manual", "web"], baseUrl: "https://openapi.alipay.com", appId: "app", sellerId: "seller", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), alipayPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), notifyUrl: "https://shop.example/api/payments/alipay/notify", returnUrl: "https://shop.example/payment-result" }));
    const payload: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: created.orderNo, trade_no: "trade-1", total_amount: "10.00", trade_status: "TRADE_SUCCESS", sign_type: "RSA2" };
    payload.sign = sign("RSA-SHA256", Buffer.from(canonicalizeAlipayParameters(payload, true)), keys.privateKey).toString("base64");
    const response = await new PaymentCallbackService(context.database).handle("ALIPAY", { payload });
    assert.equal(response.status, 400);
    assert.equal((await context.flow.query(created.orderNo, null, input.contactValue))?.paymentStatus, "UNPAID");
    assert.equal((await reconcilePendingAlipayPayments(context.database)).scanned, 0);
  } finally { context.close(); }
});
