ALTER TABLE `room_grants` ADD COLUMN `device_label` text NOT NULL DEFAULT '未知设备';
--> statement-breakpoint
ALTER TABLE `room_grants` ADD COLUMN `granted_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `room_grants` ADD COLUMN `last_seen_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `room_access_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `room_id` text NOT NULL,
  `device_label` text NOT NULL,
  `event_type` text NOT NULL,
  `occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_access_events_room_time_idx` ON `room_access_events` (`room_id`, `occurred_at`);

