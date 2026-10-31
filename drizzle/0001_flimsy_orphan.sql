ALTER TABLE `members` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `members_memorial_id_user_id_unique` ON `members` (`memorial_id`,`user_id`);