CREATE TABLE `call_external_id_conflicts` (
	`call_id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`kept_call_id` text NOT NULL,
	`cleared_at` text NOT NULL
);
--> statement-breakpoint
-- Before clearing any duplicate below, record every call that is about to lose its external_id:
-- its original external_id and the call that keeps it (`kept_call_id`), so nothing is silently
-- lost and a wrong automatic pairing can still be relinked by hand from `call_external_id_conflicts`.
-- The kept call is always the *first-inserted* one per external_id (lowest rowid).
INSERT INTO `call_external_id_conflicts` (`call_id`, `external_id`, `kept_call_id`, `cleared_at`)
SELECT `c`.`id`, `c`.`external_id`, `k`.`id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `calls` AS `c`
JOIN (
	SELECT `external_id`, MIN(`rowid`) AS `keeper_rowid`
	FROM `calls`
	WHERE `external_id` IS NOT NULL
	GROUP BY `external_id`
) AS `groups` ON `groups`.`external_id` = `c`.`external_id`
JOIN `calls` AS `k` ON `k`.`rowid` = `groups`.`keeper_rowid`
WHERE `c`.`external_id` IS NOT NULL AND `c`.`rowid` <> `groups`.`keeper_rowid`;
--> statement-breakpoint
UPDATE `calls` SET `external_id` = NULL WHERE `external_id` IS NOT NULL AND `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `calls` WHERE `external_id` IS NOT NULL GROUP BY `external_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calls_external_id_idx` ON `calls` (`external_id`) WHERE "calls"."external_id" is not null;
