CREATE TABLE `messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `room_hash` text NOT NULL,
  `body` text NOT NULL,
  `sender` text NOT NULL,
  `client_id` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_room_id_idx` ON `messages` (`room_hash`, `id`);
--> statement-breakpoint
CREATE INDEX `messages_room_created_idx` ON `messages` (`room_hash`, `created_at`);

