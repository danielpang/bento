import { bigint, boolean, index, integer, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * better-auth tables live in a dedicated "identity" schema so they never
 * collide with Supabase's reserved auth schemas when users point Bento at
 * a Supabase Postgres. The adapter needs no special configuration for
 * this: schema qualification travels with the Drizzle table object.
 *
 * Property names must match better-auth's field names exactly (camelCase);
 * the SQL column names are ours to choose. Regenerate with
 * `npx auth@latest generate` after upgrading better-auth.
 */
export const identity = pgSchema("identity");

export const user = identity.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = identity.table(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Added by the organization plugin: which org the session is acting in. */
    activeOrganizationId: text("active_organization_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = identity.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = identity.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Device authorization codes (RFC 8628), used by the TUI login.
 *
 * userId stays nullable on purpose: the plugin queries for unclaimed
 * rows with `userId is null`, and only fills it in once a signed in
 * browser session claims the code. pollingInterval is stored in
 * milliseconds even though the /device/code response reports seconds.
 */
export const deviceCode = identity.table(
  "device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (t) => [
    uniqueIndex("device_code_device_code_idx").on(t.deviceCode),
    uniqueIndex("device_code_user_code_idx").on(t.userCode),
  ],
);

/**
 * Organizations, members, and invitations, required by better-auth's
 * organization plugin. Projects belong to an organization, so a team
 * shares one board rather than each person keeping their own.
 */
export const organization = identity.table("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const member = identity.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("member_organization_id_idx").on(t.organizationId),
    uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId),
  ],
);

export const invitation = identity.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitation_organization_id_idx").on(t.organizationId), index("invitation_email_idx").on(t.email)],
);

/**
 * Rate limit counters, kept in Postgres rather than in memory.
 *
 * Memory would mean per instance limits, so a brute force spread across
 * a load balancer would get one budget per machine. The table is
 * better-auth's own shape: a key it composes, a count, and when the
 * window last moved.
 */
export const rateLimit = identity.table("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  // Epoch milliseconds, which is what better-auth stores here; a
  // timestamp column would reject the number it writes.
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
