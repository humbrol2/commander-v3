/**
 * Drizzle ORM schema — re-exports from PostgreSQL schema.
 * The PG schema is the primary schema. SQLite schema preserved in schema-sqlite.ts.
 *
 * All tables include tenant_id for multi-user isolation.
 */

export * from "./schema-pg";
