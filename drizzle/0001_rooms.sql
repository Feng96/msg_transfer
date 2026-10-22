CREATE TABLE `rooms` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `pin_salt` text NOT NULL,
  `pin_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `last_message_at` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `rooms_activity_idx` ON `rooms` (`last_message_at`, `created_at`);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_grants` (
  `token_hash` text NOT NULL,
  `room_id` text NOT NULL,
  PRIMARY KEY (`token_hash`, `room_id`)
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
  `key` text PRIMARY KEY NOT NULL,
  `count` integer NOT NULL,
  `reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `legacy_imports` (
  `legacy_hash` text NOT NULL,
  `room_id` text NOT NULL,
  PRIMARY KEY (`legacy_hash`, `room_id`)
);

