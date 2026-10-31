import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const memorials = sqliteTable(
  "memorials",
  {
    id: text("id").primaryKey(),
    owner_id: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "no action" }),
    name: text("name").notNull(),
    species: text("species").notNull(),
    born: text("born").notNull().default(""),
    passed: text("passed").notNull().default(""),
    message: text("message").notNull().default(""),
    theme: text("theme").notNull().default("A"),
    setting: text("setting").notNull().default("house"),
    style: text("style").notNull().default("stylized"),
    finish: text("finish").notNull().default("glaze"),
    visibility: text("visibility").notNull().default("private"),
    review: integer("review").notNull().default(1),
    status: text("status").notNull().default("draft"),
    moderated: integer("moderated").notNull().default(0),
    portrait_id: text("portrait_id"),
    arrangement: text("arrangement").notNull().default("[]"),
    version: integer("version").notNull().default(1),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    plot_index: integer("plot_index"),
    park_i: integer("park_i"),
    park_j: integer("park_j"),
    park_k: integer("park_k"),
  },
  (t) => [
    uniqueIndex("memorial_park_plot").on(t.park_i, t.park_j, t.park_k),
    uniqueIndex("memorial_plot").on(t.plot_index),
    index("public_memorials").on(t.status, t.visibility, t.updated_at),
  ],
);

// SQL migrations also own the guards that keep media and memory references consistent.
export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    memorial_id: text("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "no action" }),
    purpose: text("purpose").notNull(),
    filename: text("filename").notNull(),
    path: text("path").notNull(),
    original_path: text("original_path").notNull(),
    bytes: integer("bytes").notNull(),
    created_at: integer("created_at").notNull(),
    hidden: integer("hidden").notNull().default(0),
  },
  (t) => [index("memorial_media").on(t.memorial_id)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    memorial_id: text("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "no action" }),
    author: text("author").notNull(),
    title: text("title").notNull(),
    story: text("story").notNull(),
    date: text("date").notNull().default(""),
    media_ids: text("media_ids").notNull().default("[]"),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    show_name: integer("show_name").notNull().default(0),
    previous_status: text("previous_status"),
  },
  (t) => [index("memorial_memories").on(t.memorial_id, t.status)],
);

export const candles = sqliteTable(
  "candles",
  {
    id: text("id").primaryKey(),
    memorial_id: text("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "no action" }),
    author: text("author").notNull(),
    anonymous: integer("anonymous").notNull(),
    message: text("message").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("candles_memorial_id_user_id_unique").on(
      t.memorial_id,
      t.user_id,
    ),
  ],
);

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    memorial_id: text("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    user_id: text("user_id").references(() => users.id),
    name: text("name").notNull().default(""),
    role: text("role").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("member_email").on(t.email, t.status),
    uniqueIndex("members_memorial_id_user_id_unique").on(
      t.memorial_id,
      t.user_id,
    ),
    uniqueIndex("members_memorial_id_email_unique").on(t.memorial_id, t.email),
  ],
);

export const invitations = sqliteTable("invitations", {
  hash: text("hash").primaryKey(),
  member_id: text("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  expires_at: integer("expires_at").notNull(),
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  memorial_id: text("memorial_id").references(() => memorials.id, {
    onDelete: "set null",
  }),
  memory_id: text("memory_id").references(() => memories.id, {
    onDelete: "set null",
  }),
  reporter_id: text("reporter_id")
    .notNull()
    .references(() => users.id, { onDelete: "no action" }),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  status: text("status").notNull().default("pending"),
  decision: text("decision").notNull().default(""),
  created_at: integer("created_at").notNull(),
});

export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  report_id: text("report_id"),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  created_at: integer("created_at").notNull(),
  target_id: text("target_id"),
});

export const mail = sqliteTable("mail", {
  id: text("id").primaryKey(),
  context_id: text("context_id"),
  to_email: text("to_email").notNull(),
  subject: text("subject").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error").notNull().default(""),
  created_at: integer("created_at").notNull(),
  lease_token: text("lease_token"),
  lease_until: integer("lease_until").notNull().default(0),
});

export const rate_limits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  until_at: integer("until_at").notNull(),
});

export const file_cleanup = sqliteTable("file_cleanup", {
  path: text("path").primaryKey(),
  requested_by: text("requested_by").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error").notNull().default(""),
  created_at: integer("created_at").notNull(),
  lease_token: text("lease_token"),
  lease_until: integer("lease_until").notNull().default(0),
});

export const park = sqliteTable("park", {
  memorial_id: text("memorial_id")
    .primaryKey()
    .references(() => memorials.id, { onDelete: "cascade" }),
  stone: text("stone").notNull().default("classic"),
  visits: integer("visits").notNull().default(0),
  lights: integer("lights").notNull().default(0),
  toys: integer("toys").notNull().default(0),
});

// The initial SQL migration also owns the atomic park_action_count trigger.
export const park_actions = sqliteTable(
  "park_actions",
  {
    memorial_id: text("memorial_id")
      .notNull()
      .references(() => memorials.id, { onDelete: "cascade" }),
    visitor: text("visitor").notNull(),
    action: text("action").notNull(),
    day: text("day").notNull(),
  },
  (t) => [primaryKey({ columns: [t.memorial_id, t.visitor, t.action, t.day] })],
);

export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});
