CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`errand_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`token_hash` text NOT NULL,
	`external_id` text,
	`created_at` text NOT NULL,
	`ended_at` text,
	`active_grant_token` text
);
