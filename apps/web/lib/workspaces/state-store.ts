import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const MAX_ACTIVITY_ENTRIES = 100;
const MAX_TELEMETRY_SAMPLES = 60;

export type WorkspaceActivityEntry = {
  at: string;
  workspaceId: string;
  actorUserId: string;
  actorEmail: string;
  action: string;
  status: "succeeded" | "failed";
};

export type WorkspaceTelemetrySample = {
  at?: string;
  cpuPercent?: number;
  memoryPercent?: number;
};

const memoryActivity = new Map<string, WorkspaceActivityEntry[]>();
const memoryTelemetry = new Map<string, WorkspaceTelemetrySample[]>();
type SQLiteStatement = {
  run: (...values: unknown[]) => unknown;
  all: (...values: unknown[]) => Record<string, unknown>[];
};
type SQLiteDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SQLiteStatement;
};

let db: SQLiteDatabase | undefined;
let dbUnavailable = false;

function stateDbPath() {
  return (
    process.env.INCUS_WEB_WORKSPACE_STATE_DB ||
    process.env.INCUS_WEB_WORKSPACE_STATE_DB_PATH ||
    join(process.cwd(), ".next", "cache", "workspace-state.sqlite3")
  );
}

function database(): SQLiteDatabase | undefined {
  if (dbUnavailable) return undefined;
  if (db) return db;
  try {
    const { DatabaseSync } = require("node:" + "sqlite") as {
      DatabaseSync: new (path: string) => SQLiteDatabase;
    };
    const path = stateDbPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    db = new DatabaseSync(path);
    const database = db;
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        at TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_activity_workspace_id_idx
        ON workspace_activity(workspace_id, id DESC);
      CREATE TABLE IF NOT EXISTS workspace_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        cpu_percent REAL,
        memory_percent REAL
      );
      CREATE INDEX IF NOT EXISTS workspace_telemetry_workspace_id_idx
        ON workspace_telemetry(workspace_id, id DESC);
    `);
    return database;
  } catch (error) {
    console.error("workspace state database unavailable", { path: stateDbPath(), error });
    dbUnavailable = true;
    return undefined;
  }
}

export function recordActivity(entry: WorkspaceActivityEntry) {
  const store = database();
  if (!store) {
    recordActivityInMemory(entry);
    return;
  }

  try {
    store
      .prepare(
        `INSERT INTO workspace_activity
          (workspace_id, at, actor_user_id, actor_email, action, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.workspaceId, entry.at, entry.actorUserId, entry.actorEmail, entry.action, entry.status);
    store
      .prepare(
        `DELETE FROM workspace_activity
         WHERE workspace_id = ?
           AND id NOT IN (
             SELECT id FROM workspace_activity
             WHERE workspace_id = ?
             ORDER BY id DESC
             LIMIT ?
           )`,
      )
      .run(entry.workspaceId, entry.workspaceId, MAX_ACTIVITY_ENTRIES);
  } catch (error) {
    console.error("workspace activity write failed; using memory fallback", { workspaceId: entry.workspaceId, error });
    recordActivityInMemory(entry);
  }
}

export function listActivity(workspaceId: string): WorkspaceActivityEntry[] {
  const store = database();
  if (!store) return memoryActivity.get(workspaceId) ?? [];

  try {
    return store
      .prepare(
        `SELECT at, workspace_id, actor_user_id, actor_email, action, status
         FROM workspace_activity
         WHERE workspace_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(workspaceId, MAX_ACTIVITY_ENTRIES)
      .map((row: Record<string, unknown>) => ({
        at: String(row.at),
        workspaceId: String(row.workspace_id),
        actorUserId: String(row.actor_user_id),
        actorEmail: String(row.actor_email),
        action: String(row.action),
        status: row.status === "failed" ? "failed" : "succeeded",
      }));
  } catch (error) {
    console.error("workspace activity read failed; using memory fallback", { workspaceId, error });
    return memoryActivity.get(workspaceId) ?? [];
  }
}

export function appendTelemetry(
  workspaceId: string,
  sample: WorkspaceTelemetrySample,
): WorkspaceTelemetrySample[] {
  const entry = { at: new Date().toISOString(), ...sample };
  const store = database();
  if (!store) {
    return appendTelemetryInMemory(workspaceId, entry);
  }

  try {
    store
      .prepare(
        `INSERT INTO workspace_telemetry
          (workspace_id, sampled_at, cpu_percent, memory_percent)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        entry.at,
        entry.cpuPercent ?? null,
        entry.memoryPercent ?? null,
      );
    store
      .prepare(
        `DELETE FROM workspace_telemetry
         WHERE workspace_id = ?
           AND id NOT IN (
             SELECT id FROM workspace_telemetry
             WHERE workspace_id = ?
             ORDER BY id DESC
             LIMIT ?
           )`,
      )
      .run(workspaceId, workspaceId, MAX_TELEMETRY_SAMPLES);
    return listTelemetry(workspaceId);
  } catch (error) {
    console.error("workspace telemetry write failed; using memory fallback", { workspaceId, error });
    return appendTelemetryInMemory(workspaceId, entry);
  }
}

export function listTelemetry(workspaceId: string): WorkspaceTelemetrySample[] {
  const store = database();
  if (!store) return memoryTelemetry.get(workspaceId) ?? [];

  try {
    return store
      .prepare(
        `SELECT sampled_at, cpu_percent, memory_percent
         FROM workspace_telemetry
         WHERE workspace_id = ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(workspaceId, MAX_TELEMETRY_SAMPLES)
      .map((row: Record<string, unknown>) => ({
        at: String(row.sampled_at),
        cpuPercent:
          typeof row.cpu_percent === "number" && Number.isFinite(row.cpu_percent)
            ? row.cpu_percent
            : undefined,
        memoryPercent:
          typeof row.memory_percent === "number" && Number.isFinite(row.memory_percent)
            ? row.memory_percent
            : undefined,
      }));
  } catch (error) {
    console.error("workspace telemetry read failed; using memory fallback", { workspaceId, error });
    return memoryTelemetry.get(workspaceId) ?? [];
  }
}

function recordActivityInMemory(entry: WorkspaceActivityEntry) {
  const next = [entry, ...(memoryActivity.get(entry.workspaceId) ?? [])].slice(
    0,
    MAX_ACTIVITY_ENTRIES,
  );
  memoryActivity.set(entry.workspaceId, next);
}

function appendTelemetryInMemory(
  workspaceId: string,
  entry: WorkspaceTelemetrySample,
) {
  const next = [...(memoryTelemetry.get(workspaceId) ?? []), entry].slice(
    -MAX_TELEMETRY_SAMPLES,
  );
  memoryTelemetry.set(workspaceId, next);
  return next;
}
