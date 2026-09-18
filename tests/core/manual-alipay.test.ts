import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
// @ts-expect-error Tests use Bun without its global type package.
import { test } from "bun:test";
import { alipayFormFields, DEFAULT_ALIPAY_COLLECTION_IMAGE } from "../../lib/alipay-manual";
import { ORDER_PAYMENT_TIMEOUT_MS } from "../../lib/order-state";
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
    // Newly created orders stay payable until the payment timeout.
    assert.equal((await closeExpiredPendingOrders(database, new Date(Date.now() - ORDER_PAYMENT_TIMEOUT_MS))).closed, 0);
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


test("buyer cancellation checks ownership and releases stock and discount reservations once", async () => {
  const context = fixture();
  try {
    context.sqlite.query("UPDATE productSku SET deliveryType = 'MANUAL', physicalStock = 2 WHERE id = 1").run();
    const now = Date.now();
    context.sqlite.query("INSERT INTO discountCode (code, type, value, usedCount, reservedCount, isActive, createdAt, updatedAt) VALUES ('CANCEL', 'FIXED', 100, 0, 0, 1, ?, ?)").run(now, now);
    const created = await context.flow.create({ ...input, discountCode: "CANCEL" }, null);
    await assert.rejects(() => context.flow.cancel(created.orderNo, null), /ORDER_NOT_FOUND/);
    await assert.rejects(() => context.flow.cancel(created.orderNo, null, "wrong@example.com"), /ORDER_NOT_FOUND/);
    assert.equal((context.sqlite.query("SELECT physicalStock FROM productSku WHERE id = 1").get() as { physicalStock: number }).physicalStock, 1);
    await context.flow.cancel(created.orderNo, null, input.contactValue);
    await context.flow.cancel(created.orderNo, null, input.contactValue);
    assert.equal((context.sqlite.query("SELECT physicalStock FROM productSku WHERE id = 1").get() as { physicalStock: number }).physicalStock, 2);
    assert.deepEqual(context.sqlite.query("SELECT reservedCount, usedCount FROM discountCode WHERE code = 'CANCEL'").get(), { reservedCount: 0, usedCount: 0 });
    assert.equal((await context.flow.query(created.orderNo, null, input.contactValue))?.status, "CLOSED");
    await assert.rejects(() => context.flow.resume(created.orderNo, null, input.contactValue), /ORDER_NOT_FOUND/);
    assert.equal((context.sqlite.query("SELECT COUNT(*) AS total FROM paymentLog WHERE eventType = 'USER_CANCEL'").get() as { total: number }).total, 1);
  } finally { context.close(); }
});

test("only the account owner can cancel an account order; paid orders cannot be cancelled", async () => {
  const context = fixture();
  try {
    const now = Date.now();
    context.sqlite.query("INSERT INTO user (id, name, email, emailVerified, twoFactorEnabled, createdAt, updatedAt) VALUES ('owner', 'Owner', ?, 1, 0, ?, ?)").run(input.contactValue, now, now);
    const created = await context.flow.create(input, "owner");
    await assert.rejects(() => context.flow.cancel(created.orderNo, "someone-else"), /ORDER_NOT_FOUND/);
    await assert.rejects(() => context.flow.cancel(created.orderNo, null, input.contactValue), /ORDER_NOT_FOUND/);
    await context.flow.cancel(created.orderNo, "owner");
    const paid = await context.flow.create(input, "owner");
    const record = context.sqlite.query("SELECT id FROM `order` WHERE orderNo = ?").get(paid.orderNo) as { id: number };
    await context.flow.confirmManual(record.id, "10.00", "admin-1");
    await assert.rejects(() => context.flow.cancel(paid.orderNo, "owner"), /ORDER_CANNOT_CANCEL/);
  } finally { context.close(); }
});

test("manual orders close at 30 minutes while newer and paid orders stay unchanged", async () => {
  const context = fixture();
  try {
    assert.equal(ORDER_PAYMENT_TIMEOUT_MS, 30 * 60 * 1000);
    const cutoff = Date.now() - ORDER_PAYMENT_TIMEOUT_MS;
    const expired = await context.flow.create(input, null);
    const fresh = await context.flow.create(input, null);
    const paid = await context.flow.create(input, null);
    context.sqlite.query("UPDATE `order` SET createdAt = ? WHERE orderNo IN (?, ?)").run(cutoff, expired.orderNo, paid.orderNo);
    context.sqlite.query("UPDATE `order` SET createdAt = ? WHERE orderNo = ?").run(cutoff + 1, fresh.orderNo);
    const record = context.sqlite.query("SELECT id FROM `order` WHERE orderNo = ?").get(paid.orderNo) as { id: number };
    await context.flow.confirmManual(record.id, "10.00", "admin-1");
    assert.deepEqual(await closeExpiredPendingOrders(context.database, new Date(cutoff)), { scanned: 1, closed: 1 });
    assert.equal((await context.flow.query(expired.orderNo, null, input.contactValue))?.status, "CLOSED");
    assert.equal((await context.flow.query(fresh.orderNo, null, input.contactValue))?.status, "PENDING");
    assert.equal((await context.flow.query(paid.orderNo, null, input.contactValue))?.paymentStatus, "PAID");
    assert.equal((await closeExpiredPendingOrders(context.database, new Date(cutoff))).closed, 0);
    assert.deepEqual(context.sqlite.query("SELECT eventType, message FROM paymentLog WHERE eventType = 'AUTO_CLOSE'").get(), { eventType: "AUTO_CLOSE", message: "订单超时未支付，已自动关闭（30分钟）" });
  } finally { context.close(); }
});

test("cancellation reconciles API payments and refuses to close on query failures", async () => {
  const context = fixture();
  const definition = paymentProviderDefinitions.ALIPAY;
  const originalAdapter = definition.createAdapter;
  try {
    const created = await context.flow.create(input, null);
    context.sqlite.query("UPDATE `order` SET paymentChannel = 'web' WHERE orderNo = ?").run(created.orderNo);
    let verified = false;
    definition.createAdapter = (values) => ({ ...originalAdapter(values), query: async () => ({ provider: "ALIPAY", orderNo: created.orderNo, amount: 1000, status: "PAID", verified, message: "TEST" }) });
    await assert.rejects(() => context.flow.cancel(created.orderNo, null, input.contactValue), /ORDER_PAYMENT_CHECK_FAILED/);
    assert.equal((context.sqlite.query("SELECT status FROM `order` WHERE orderNo = ?").get(created.orderNo) as { status: string }).status, "PENDING");
    verified = true;
    await assert.rejects(() => context.flow.cancel(created.orderNo, null, input.contactValue), /ORDER_CANNOT_CANCEL/);
    assert.equal((context.sqlite.query("SELECT paymentStatus FROM `order` WHERE orderNo = ?").get(created.orderNo) as { paymentStatus: string }).paymentStatus, "PAID");
  } finally { definition.createAdapter = originalAdapter; context.close(); }
});
