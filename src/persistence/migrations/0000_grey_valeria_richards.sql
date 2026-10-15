CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`errand_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`participant_ids` text NOT NULL,
	`status` text NOT NULL,
	`history` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_open_errand_idx` ON `bookings` (`errand_id`) WHERE "bookings"."status" <> 'cancelled';--> statement-breakpoint
CREATE TABLE `commit_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`errand_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`token` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commit_grants_token_unique` ON `commit_grants` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `commit_grants_active_errand_idx` ON `commit_grants` (`errand_id`) WHERE "commit_grants"."status" = 'active';--> statement-breakpoint
CREATE TABLE `errands` (
	`id` text PRIMARY KEY NOT NULL,
	`brief` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`errand_id` text NOT NULL,
	`offer` text NOT NULL,
	`created_at` text NOT NULL
);
