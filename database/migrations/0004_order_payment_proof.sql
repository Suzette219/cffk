CREATE TABLE `orderPaymentProof` (
	`orderId` integer PRIMARY KEY NOT NULL,
	`transactionNo` text,
	`screenshot` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "orderPaymentProof_evidence_required" CHECK("orderPaymentProof"."transactionNo" IS NOT NULL OR "orderPaymentProof"."screenshot" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orderPaymentProof_transactionNo_unique` ON `orderPaymentProof` (`transactionNo`);