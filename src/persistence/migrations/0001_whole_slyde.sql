CREATE TABLE `webhook_events` (
	`event_key` text PRIMARY KEY NOT NULL,
	`received_at` text NOT NULL,
	`payload_sha256` text NOT NULL
);
