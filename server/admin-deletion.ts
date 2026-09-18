import { appError } from "@/lib/app-error";

async function assertDeletionAdmin(database: D1Database, adminUserId: string) {
  const admin = await database.prepare("SELECT u.id FROM adminBootstrap b JOIN user u ON u.id = b.userId WHERE b.id = 1 AND u.id = ? AND u.disabledAt IS NULL AND u.deletedAt IS NULL").bind(adminUserId).first();
  if (!admin) appError("ADMIN_ACCESS_REQUIRED");
}

// Keep the order and its ownership/payment evidence for reconciliation and audit.
export async function deleteManagedOrder(database: D1Database, orderId: number, adminUserId: string) {
  await assertDeletionAdmin(database, adminUserId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) appError("ORDER_NOT_FOUND");
  const result = await database.prepare("UPDATE `order` SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL AND status = 'CLOSED' AND paymentStatus = 'UNPAID'").bind(Date.now(), Date.now(), orderId).run();
  if (result.meta.changes !== 1) appError("ORDER_DELETE_NOT_ALLOWED");
  return { deleted: true as const };
}

// A tombstone preserves account-order ownership; never turn account orders into guest orders.
export async function deleteManagedUser(database: D1Database, userId: string, adminUserId: string) {
  await assertDeletionAdmin(database, adminUserId);
  if (!userId || userId.length > 255) appError("ADMIN_USER_NOT_FOUND");
  if (userId === adminUserId) appError("ADMIN_SELF_DELETE_FORBIDDEN");
  const now = Date.now();
  try {
    await database.batch([
      database.prepare("UPDATE user SET deletedAt = ?, disabledAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL AND NOT EXISTS (SELECT 1 FROM adminBootstrap WHERE userId = user.id)").bind(now, now, now, userId),
      database.prepare("INSERT INTO transactionGuard (id, value) VALUES (1, changes()) ON CONFLICT(id) DO UPDATE SET value = excluded.value"),
      database.prepare("DELETE FROM session WHERE userId = ?").bind(userId),
    ]);
  } catch (cause) {
    if (String(cause).includes("transactionGuard_value_check")) appError("ADMIN_USER_DELETE_NOT_ALLOWED");
    throw cause;
  }
  return { deleted: true as const };
}
