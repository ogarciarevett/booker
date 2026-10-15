-- Rebuilds webhook_events for two-phase claims with a per-claim token and a stored lease
-- deadline. Rows recorded by the first scheme were already processed, so they become completed
-- claims and keep their deduplication; they have no claim_token or lease_expires_at, since those
-- only matter for a still-pending claim.
CREATE TABLE `__new_webhook_events` (
	`event_key` text PRIMARY KEY NOT NULL,
	`payload_sha256` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` text NOT NULL,
	`completed_at` text,
	`claim_token` text,
	`lease_expires_at` text
);
--> statement-breakpoint
INSERT INTO `__new_webhook_events` (`event_key`, `payload_sha256`, `status`, `claimed_at`, `completed_at`)
SELECT `event_key`, `payload_sha256`, 'completed', `received_at`, `received_at` FROM `webhook_events`;
--> statement-breakpoint
DROP TABLE `webhook_events`;
--> statement-breakpoint
ALTER TABLE `__new_webhook_events` RENAME TO `webhook_events`;
