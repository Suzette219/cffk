import assert from "node:assert/strict";
// @ts-expect-error Tests run with Bun without its global type package.
import { test } from "bun:test";
import { deleteManagedOrder, deleteManagedUser } from "../../server/admin-deletion";
import { getOrderForQuery } from "../../server/order/service";
import { createTestDatabase } from "../helpers/sqlite-d1";

function fixture() {
  const context = createTestDatabase();
  const now = Date.now();
  for (const id of ["admin", "buyer", "other"]) {
    context.sqlite.query("INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)").run(id, id, `${id}@example.com`, now, now);
    context.sqlite.query("INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)").run(`session-${id}`, `token-${id}`, id, now + 60000, now, now);
  }
  context.sqlite.query("INSERT INTO adminBootstrap (id,userId,createdAt) VALUES (1,'admin',?)").run(now);
  context.sqlite.query("INSERT INTO product_v2 (id,name,slug,status,createdAt,updatedAt) VALUES (1,'Test','test','ACTIVE',?,?)").run(now, now);
  context.sqlite.query("INSERT INTO `order` (id,orderNo,ownerUserId,productId,productNameSnapshot,unitPrice,quantity,amount,contactType,contactValue,contactEmailNormalized,paymentProvider,paymentChannel,deliveryTypeSnapshot,status,paymentStatus,createdAt,updatedAt) VALUES (1,'TEST-ORDER','buyer',1,'Test',100,1,100,'EMAIL','buyer@example.com','buyer@example.com','ALIPAY','manual','MANUAL','CLOSED','UNPAID',?,?)").run(now, now);
  context.sqlite.query("INSERT INTO orderPaymentProof (orderId,transactionNo,createdAt) VALUES (1,'2026091822001234567890123456',?)").run(now);
  return context;
}

test("only a current active root administrator can delete orders or users", async () => {
  const c = fixture();
  try {
    for (const actor of ["", "buyer", "other", "missing"]) {
      await assert.rejects(() => deleteManagedOrder(c.database, 1, actor), /ADMIN_ACCESS_REQUIRED/);
      await assert.rejects(() => deleteManagedUser(c.database, "buyer", actor), /ADMIN_ACCESS_REQUIRED/);
    }
    await assert.rejects(() => deleteManagedUser(c.database, "admin", "admin"), /ADMIN_SELF_DELETE_FORBIDDEN/);
    c.sqlite.query("UPDATE user SET disabledAt = 1 WHERE id = 'admin'").run();
    await assert.rejects(() => deleteManagedOrder(c.database, 1, "admin"), /ADMIN_ACCESS_REQUIRED/);
    assert.equal(c.sqlite.query("SELECT deletedAt FROM `order` WHERE id = 1").get().deletedAt, null);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM session").get().n, 3);
  } finally { c.close(); }
});

test("order deletion accepts only closed unpaid orders and preserves payment evidence and buyer access", async () => {
  const c = fixture();
  try {
    for (const status of ["PENDING", "PAID", "DELIVERED", "FAILED"]) {
      c.sqlite.query("UPDATE `order` SET status = ? WHERE id = 1").run(status);
      await assert.rejects(() => deleteManagedOrder(c.database, 1, "admin"), /ORDER_DELETE_NOT_ALLOWED/);
    }
    c.sqlite.query("UPDATE `order` SET status = 'CLOSED', paymentStatus = 'PAID' WHERE id = 1").run();
    await assert.rejects(() => deleteManagedOrder(c.database, 1, "admin"), /ORDER_DELETE_NOT_ALLOWED/);
    c.sqlite.query("UPDATE `order` SET paymentStatus = 'UNPAID' WHERE id = 1").run();
    await deleteManagedOrder(c.database, 1, "admin");
    assert.ok(c.sqlite.query("SELECT deletedAt FROM `order` WHERE id = 1").get().deletedAt);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM `order` WHERE deletedAt IS NULL").get().n, 0);
    const record = await getOrderForQuery(c.database, "TEST-ORDER", "buyer");
    assert.equal(record?.status, "CLOSED");
    assert.equal(record?.paymentProof?.transactionNo, "2026091822001234567890123456");
    await assert.rejects(() => deleteManagedOrder(c.database, 1, "admin"), /ORDER_DELETE_NOT_ALLOWED/);
  } finally { c.close(); }
});

test("user deletion hides and disables the user, revokes only their sessions, and retains account order ownership", async () => {
  const c = fixture();
  try {
    await deleteManagedUser(c.database, "buyer", "admin");
    const user = c.sqlite.query("SELECT deletedAt, disabledAt, email FROM user WHERE id = 'buyer'").get();
    assert.ok(user.deletedAt);
    assert.ok(user.disabledAt);
    assert.equal(user.email, "buyer@example.com");
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM user WHERE id = 'buyer' AND deletedAt IS NULL").get().n, 0);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM session WHERE userId = 'buyer'").get().n, 0);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM session WHERE userId != 'buyer'").get().n, 2);
    assert.equal(c.sqlite.query("SELECT ownerUserId FROM `order` WHERE id = 1").get().ownerUserId, "buyer");
    assert.equal(await getOrderForQuery(c.database, "TEST-ORDER", null, "buyer@example.com"), null);
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM orderPaymentProof").get().n, 1);
    await assert.rejects(() => deleteManagedUser(c.database, "buyer", "admin"), /ADMIN_USER_DELETE_NOT_ALLOWED/);
    await assert.rejects(() => deleteManagedUser(c.database, "missing", "admin"), /ADMIN_USER_DELETE_NOT_ALLOWED/);
  } finally { c.close(); }
});

test("failed session revocation rolls back the entire user deletion", async () => {
  const c = fixture();
  try {
    c.sqlite.run("CREATE TRIGGER fail_session_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await assert.rejects(() => deleteManagedUser(c.database, "buyer", "admin"), /test failure/);
    assert.deepEqual(c.sqlite.query("SELECT disabledAt, deletedAt FROM user WHERE id = 'buyer'").get(), { disabledAt: null, deletedAt: null });
    assert.equal(c.sqlite.query("SELECT count(*) AS n FROM session WHERE userId = 'buyer'").get().n, 1);
  } finally { c.close(); }
});
