CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`report_id` text,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`target_id` text
);
--> statement-breakpoint
CREATE TABLE `candles` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`user_id` text NOT NULL,
	`author` text NOT NULL,
	`anonymous` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candles_memorial_id_user_id_unique` ON `candles` (`memorial_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_cleanup` (
	`path` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`hash` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mail` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`original_path` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memorial_media` ON `media` (`memorial_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_email` ON `members` (`email`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_memorial_id_email_unique` ON `members` (`memorial_id`,`email`);--> statement-breakpoint
CREATE TABLE `memorials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`species` text NOT NULL,
	`born` text DEFAULT '' NOT NULL,
	`passed` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`theme` text DEFAULT 'A' NOT NULL,
	`setting` text DEFAULT 'house' NOT NULL,
	`style` text DEFAULT 'stylized' NOT NULL,
	`finish` text DEFAULT 'glaze' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`review` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`moderated` integer DEFAULT 0 NOT NULL,
	`portrait_id` text,
	`arrangement` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`plot_index` integer,
	`park_i` integer,
	`park_j` integer,
	`park_k` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memorial_park_plot` ON `memorials` (`park_i`,`park_j`,`park_k`);--> statement-breakpoint
CREATE UNIQUE INDEX `memorial_plot` ON `memorials` (`plot_index`);--> statement-breakpoint
CREATE INDEX `public_memorials` ON `memorials` (`status`,`visibility`,`updated_at`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text NOT NULL,
	`user_id` text NOT NULL,
	`author` text NOT NULL,
	`title` text NOT NULL,
	`story` text NOT NULL,
	`date` text DEFAULT '' NOT NULL,
	`media_ids` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`show_name` integer DEFAULT 0 NOT NULL,
	`previous_status` text,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memorial_memories` ON `memories` (`memorial_id`,`status`);--> statement-breakpoint
CREATE TABLE `park` (
	`memorial_id` text PRIMARY KEY NOT NULL,
	`stone` text DEFAULT 'classic' NOT NULL,
	`visits` integer DEFAULT 0 NOT NULL,
	`lights` integer DEFAULT 0 NOT NULL,
	`toys` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `park_actions` (
	`memorial_id` text NOT NULL,
	`visitor` text NOT NULL,
	`action` text NOT NULL,
	`day` text NOT NULL,
	PRIMARY KEY(`memorial_id`, `visitor`, `action`, `day`),
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`until_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`memorial_id` text,
	`memory_id` text,
	`reporter_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memorial_id`) REFERENCES `memorials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TRIGGER park_action_count AFTER INSERT ON park_actions BEGIN
 INSERT INTO park(memorial_id,visits,lights,toys)
 VALUES(NEW.memorial_id,CASE WHEN NEW.action='visit' THEN 1 ELSE 0 END,CASE WHEN NEW.action='light' THEN 1 ELSE 0 END,CASE WHEN NEW.action='toy' THEN 1 ELSE 0 END)
 ON CONFLICT(memorial_id) DO UPDATE SET visits=visits+excluded.visits,lights=lights+excluded.lights,toys=toys+excluded.toys;
END;
