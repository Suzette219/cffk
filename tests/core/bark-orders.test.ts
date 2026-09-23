import assert from "node:assert/strict";
// @ts-expect-error Tests run with Bun without its global type package.
import { test } from "bun:test";
import { createTestDatabase } from "../helpers/sqlite-d1";
import { createOrder } from "../../server/order/service";
import { processOrderEvents } from "../../server/email/order-events";
import { sendBarkOrderCreated } from "../../server/push/bark";

function fixture() {
  const c = createTestDatabase();
  const now = Date.now();
  c.sqlite.query("INSERT INTO product_v2 (id,name,slug,status,createdAt,updatedAt) VALUES (1,'测试商品','bark-test','ACTIVE',?,?)").run(now,now);
  c.sqlite.query("INSERT INTO productSku (id,productId,name,price,status,deliveryType,minBuy,maxBuy,physicalStock,createdAt,updatedAt) VALUES (1,1,'默认',1000,'ACTIVE','MANUAL',1,5,9,?,?)").run(now,now);
  return c;
}
const input = { productId: 1, productSkuId: 1, quantity: 2, paymentProvider: "ALIPAY" as const, paymentChannel: "manual" as const, contactType: "EMAIL" as const, contactValue: "private@example.com" };

test("new order queues one Bark push containing only the order notice and number", async () => {
  const c = fixture(), originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    globalThis.fetch = (async (url, init) => { requests.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response(JSON.stringify({code:200})); }) as typeof fetch;
    const created = await createOrder(c.database, input, null);
    assert.equal(requests.length,0);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM orderEvent WHERE scene = 'ORDER_CREATED'").get().n,1);
    assert.deepEqual(await processOrderEvents(c.database, { BARK_DEVICE_KEY: "test-device-key" }), {attempted:1,processed:1,failed:0});
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,"https://api.day.app/push");
    assert.equal(requests[0].body.device_key,"test-device-key");
    assert.deepEqual(requests[0].body, { device_key: "test-device-key", title: "有订单", body: `订单号：${created.orderNo}`, group: "商城订单" });
    assert.ok(!JSON.stringify(requests[0].body).includes(input.contactValue));
    assert.deepEqual(await processOrderEvents(c.database, { BARK_DEVICE_KEY: "test-device-key" }),{attempted:0,processed:0,failed:0});
  } finally {globalThis.fetch=originalFetch;c.close();}
});

test("Bark provider errors retry later without changing the order", async () => {
  const c = fixture(), originalFetch = globalThis.fetch;
  try {
    const created = await createOrder(c.database,input,null);
    globalThis.fetch = (async () => new Response(JSON.stringify({code:400,message:"rejected"}))) as typeof fetch;
    const now = new Date();
    assert.deepEqual(await processOrderEvents(c.database,{BARK_DEVICE_KEY:"test"},now),{attempted:1,processed:0,failed:1});
    assert.equal(c.sqlite.query("SELECT status FROM `order` WHERE orderNo = ?").get(created.orderNo).status,"PENDING");
    assert.deepEqual(await processOrderEvents(c.database,{BARK_DEVICE_KEY:"test"},now),{attempted:0,processed:0,failed:0});
    globalThis.fetch = (async () => new Response(JSON.stringify({code:200}))) as typeof fetch;
    assert.deepEqual(await processOrderEvents(c.database,{BARK_DEVICE_KEY:"test"},new Date(now.getTime()+61000)),{attempted:1,processed:1,failed:0});
  } finally {globalThis.fetch=originalFetch;c.close();}
});

test("missing configuration skips notifications and invalid orders do not queue events", async () => {
  const c=fixture(),originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=(async()=>{throw new Error("should not fetch");}) as typeof fetch;
    await assert.rejects(()=>createOrder(c.database,{...input,quantity:9},null),/PRODUCT_QUANTITY_INVALID/);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM orderEvent").get().n,0);
    c.sqlite.query("UPDATE productSku SET physicalStock = 1 WHERE id = 1").run();
    await assert.rejects(()=>createOrder(c.database,input,null),/PRODUCT_STOCK_NOT_ENOUGH/);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM orderEvent").get().n,0);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM `order`").get().n,0);
    c.sqlite.query("UPDATE productSku SET physicalStock = 9 WHERE id = 1").run();
    await createOrder(c.database,input,null);
    assert.deepEqual(await processOrderEvents(c.database,{}),{attempted:1,processed:1,failed:0});
    await assert.rejects(()=>sendBarkOrderCreated({BARK_DEVICE_KEY:"secret"},{productName:"测试",orderNo:"ORD",quantity:1,amount:"10.00"}),/^Error: BARK_PUSH_FAILED$/);
  } finally {globalThis.fetch=originalFetch;c.close();}
});
