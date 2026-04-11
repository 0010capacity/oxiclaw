import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

// ---------------------------------------------------------------------------
// Prepared statement cache
//
// better-sqlite3's .prepare() calls sqlite3_prepare_v2 each time.
// Caching statements avoids redundant C-level preparation overhead on hot paths.
// Initialized in initDatabase() / _initTestDatabase() after createSchema().
// ---------------------------------------------------------------------------

let stmtStoreMessage: Database.Statement;
let stmtStoreMessageDirect: Database.Statement;
let stmtStoreChatMetadataWithName: Database.Statement;
let stmtStoreChatMetadataNoName: Database.Statement;
let stmtUpdateChatName: Database.Statement;
let stmtGetAllChats: Database.Statement;
let stmtGetLastGroupSync: Database.Statement;
let stmtSetLastGroupSync: Database.Statement;
let stmtGetNewMessages: Database.Statement | null = null; // dynamic — rebuilt per jid count
let stmtGetNewMessagesCache = new Map<string, Database.Statement>();
let stmtGetMessagesSince: Database.Statement;
let stmtGetLastBotMessageTimestamp: Database.Statement;
let stmtCreateTask: Database.Statement;
let stmtGetTaskById: Database.Statement;
let stmtGetTasksForGroup: Database.Statement;
let stmtGetAllTasks: Database.Statement;
let stmtGetDueTasks: Database.Statement;
let stmtUpdateTaskAfterRun: Database.Statement;
let stmtLogTaskRun: Database.Statement;
let stmtDeleteTaskLogs: Database.Statement;
let stmtDeleteTask: Database.Statement;
let stmtGetRouterState: Database.Statement;
let stmtSetRouterState: Database.Statement;
let stmtGetSession: Database.Statement;
let stmtSetSession: Database.Statement;
let stmtDeleteSession: Database.Statement;
let stmtCreateAgentSession: Database.Statement;
let stmtGetActiveSessions: Database.Statement;
let stmtGetAgentSessionMetadata: Database.Statement;
let stmtEndAgentSession: Database.Statement;
let stmtGetAllSessions: Database.Statement;
let stmtCreateMeeting: Database.Statement;
let stmtGetActiveMeetings: Database.Statement;
let stmtEndMeeting: Database.Statement;
let stmtCreateProactiveMessage: Database.Statement;
let stmtGetProactiveMessagesForGroup: Database.Statement;
let stmtCreateMeetingTurn: Database.Statement;
let stmtGetMeetingTurns: Database.Statement;
let stmtGetRegisteredGroup: Database.Statement;
let stmtSetRegisteredGroup: Database.Statement;
let stmtGetAllRegisteredGroups: Database.Statement;

function initStatements(): void {
  stmtStoreMessage = db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmtStoreMessageDirect = db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmtStoreChatMetadataWithName = db.prepare(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       last_message_time = MAX(last_message_time, excluded.last_message_time),
       channel = COALESCE(excluded.channel, channel),
       is_group = COALESCE(excluded.is_group, is_group)`,
  );
  stmtStoreChatMetadataNoName = db.prepare(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       last_message_time = MAX(last_message_time, excluded.last_message_time),
       channel = COALESCE(excluded.channel, channel),
       is_group = COALESCE(excluded.is_group, is_group)`,
  );
  stmtUpdateChatName = db.prepare(
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
  );
  stmtGetAllChats = db.prepare(
    `SELECT jid, name, last_message_time, channel, is_group FROM chats ORDER BY last_message_time DESC`,
  );
  stmtGetLastGroupSync = db.prepare(
    `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
  );
  stmtSetLastGroupSync = db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  );
  stmtGetMessagesSince = db.prepare(
    `SELECT * FROM (
       SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
              reply_to_message_id, reply_to_message_content, reply_to_sender_name
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
         AND is_bot_message = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT ?
     ) ORDER BY timestamp`,
  );
  stmtGetLastBotMessageTimestamp = db.prepare(
    `SELECT MAX(timestamp) as ts FROM messages WHERE chat_jid = ? AND is_bot_message = 1`,
  );
  stmtCreateTask = db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmtGetTaskById = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
  stmtGetTasksForGroup = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
  );
  stmtGetAllTasks = db.prepare(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  stmtGetDueTasks = db.prepare(
    `SELECT * FROM scheduled_tasks
     WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
     ORDER BY next_run`,
  );
  stmtUpdateTaskAfterRun = db.prepare(
    `UPDATE scheduled_tasks
     SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
     WHERE id = ?`,
  );
  stmtLogTaskRun = db.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmtDeleteTaskLogs = db.prepare(
    'DELETE FROM task_run_logs WHERE task_id = ?',
  );
  stmtDeleteTask = db.prepare(
    'DELETE FROM scheduled_tasks WHERE id = ?',
  );
  stmtGetRouterState = db.prepare(
    'SELECT value FROM router_state WHERE key = ?',
  );
  stmtSetRouterState = db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  );
  stmtGetSession = db.prepare(
    'SELECT session_id FROM sessions WHERE group_folder = ?',
  );
  stmtSetSession = db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  );
  stmtDeleteSession = db.prepare(
    'DELETE FROM sessions WHERE group_folder = ?',
  );
  stmtCreateAgentSession = db.prepare(
    `INSERT INTO agent_sessions (id, group_id, container_id, status, started_at, last_health_check, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmtGetActiveSessions = db.prepare(
    `SELECT id, group_id, container_id, status, started_at, last_health_check, metadata
     FROM agent_sessions
     WHERE status = 'active'
     ORDER BY started_at DESC`,
  );
  stmtGetAgentSessionMetadata = db.prepare(
    'SELECT metadata FROM agent_sessions WHERE id = ?',
  );
  stmtEndAgentSession = db.prepare(
    `UPDATE agent_sessions SET status = 'ended', metadata = ? WHERE id = ?`,
  );
  stmtGetAllSessions = db.prepare(
    'SELECT group_folder, session_id FROM sessions',
  );
  stmtCreateMeeting = db.prepare(
    `INSERT INTO meetings (id, chat_id, agenda, moderator, participants, turns, status, started_at)
     VALUES (?, ?, ?, ?, ?, 0, 'active', ?)`,
  );
  stmtGetActiveMeetings = db.prepare(
    `SELECT * FROM meetings WHERE status = 'active' ORDER BY started_at DESC`,
  );
  stmtEndMeeting = db.prepare(
    `UPDATE meetings SET status = 'completed', ended_at = ?, summary = ? WHERE id = ?`,
  );
  stmtCreateProactiveMessage = db.prepare(
    `INSERT INTO proactive_messages (chat_id, topic, content, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  stmtGetProactiveMessagesForGroup = db.prepare(
    `SELECT * FROM proactive_messages WHERE chat_id = ? ORDER BY created_at DESC`,
  );
  stmtCreateMeetingTurn = db.prepare(
    `INSERT INTO meeting_turns (meeting_id, agent, content, timestamp)
     VALUES (?, ?, ?, ?)`,
  );
  stmtGetMeetingTurns = db.prepare(
    `SELECT * FROM meeting_turns WHERE meeting_id = ? ORDER BY timestamp ASC`,
  );
  stmtGetRegisteredGroup = db.prepare(
    'SELECT * FROM registered_groups WHERE jid = ?',
  );
  stmtSetRegisteredGroup = db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmtGetAllRegisteredGroups = db.prepare(
    'SELECT * FROM registered_groups',
  );
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      container_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      last_health_check TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_group ON agent_sessions(group_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      agenda TEXT NOT NULL,
      moderator TEXT NOT NULL,
      participants TEXT NOT NULL,
      turns INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_chat ON meetings(chat_id);
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

    CREATE TABLE IF NOT EXISTS proactive_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_chat ON proactive_messages(chat_id);

    CREATE TABLE IF NOT EXISTS meeting_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_turns_meeting ON meeting_turns(meeting_id);
  `);

  // Add context_mode column if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%' AND jid NOT LIKE 'tg:-100%' AND channel IS NULL`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:-100%' AND channel IS NULL`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Ensure agent_sessions table exists.
  // The CREATE TABLE IF NOT EXISTS in createSchema handles new DBs;
  // this handles the case where an existing DB is opened and the table
  // might be missing.
  try {
    const tableExists = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'`,
      )
      .get();
    if (!tableExists) {
      database.exec(`
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          container_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          last_health_check TEXT,
          metadata TEXT
        );
        CREATE INDEX idx_agent_sessions_group ON agent_sessions(group_id);
        CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
      `);
      logger.info('Created agent_sessions table (migration)');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check/create agent_sessions table');
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  initStatements();

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
  taskCache = null;
  stmtGetNewMessagesCache.clear();
  initStatements();
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    stmtStoreChatMetadataWithName.run(chatJid, name, timestamp, ch, group);
  } else {
    stmtStoreChatMetadataNoName.run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  stmtUpdateChatName.run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return stmtGetAllChats.all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  const row = stmtGetLastGroupSync.get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  stmtSetLastGroupSync.run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  stmtStoreMessage.run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  stmtStoreMessageDirect.run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };
  const placeholders = jids.map(() => '?').join(',');
  // Cache statement by placeholder count (varies with number of groups)
  let stmt = stmtGetNewMessagesCache.get(placeholders);
  if (!stmt) {
    stmt = db.prepare(`
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
               reply_to_message_id, reply_to_message_content, reply_to_sender_name
        FROM messages
        WHERE timestamp > ? AND chat_jid IN (${placeholders})
          AND is_bot_message = 0
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `);
    stmtGetNewMessagesCache.set(placeholders, stmt);
  }

  const rows = stmt.all(lastTimestamp, ...jids, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return stmtGetMessagesSince.all(chatJid, sinceTimestamp, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = stmtGetLastBotMessageTimestamp.get(chatJid) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  stmtCreateTask.run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
  invalidateTaskCache();
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return stmtGetTaskById.get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return stmtGetTasksForGroup.all(groupFolder) as ScheduledTask[];
}

// --- Task cache ---
let taskCache: ScheduledTask[] | null = null;

function invalidateTaskCache(): void {
  taskCache = null;
}

export function getAllTasks(): ScheduledTask[] {
  if (taskCache !== null) return taskCache;
  taskCache = stmtGetAllTasks.all() as ScheduledTask[];
  return taskCache;
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
  invalidateTaskCache();
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  stmtDeleteTaskLogs.run(id);
  stmtDeleteTask.run(id);
  invalidateTaskCache();
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return stmtGetDueTasks.all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  stmtUpdateTaskAfterRun.run(nextRun, now, lastResult, nextRun, id);
  invalidateTaskCache();
}

export function logTaskRun(log: TaskRunLog): void {
  stmtLogTaskRun.run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = stmtGetRouterState.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  stmtSetRouterState.run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = stmtGetSession.get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  stmtSetSession.run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  stmtDeleteSession.run(groupFolder);
}

// --- Agent session accessors ---

export interface AgentSession {
  id: string;
  group_id: string;
  container_id: string | null;
  status: string;
  started_at: string;
  last_health_check: string | null;
  metadata: string | null;
}

export interface Meeting {
  id: string;
  chat_id: string;
  agenda: string;
  moderator: string;
  participants: string;
  turns: number;
  status: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface ProactiveMessage {
  id: number;
  chat_id: string;
  topic: string;
  content: string;
  created_at: string;
}

export interface MeetingTurn {
  id: number;
  meeting_id: string;
  agent: string;
  content: string;
  timestamp: string;
}

/**
 * Create a new agent session record.
 * Returns the session ID.
 */
export function createAgentSession(session: {
  id: string;
  group_id: string;
  container_id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  stmtCreateAgentSession.run(
    session.id,
    session.group_id,
    session.container_id ?? null,
    session.status ?? 'active',
    now,
    null,
    session.metadata ? JSON.stringify(session.metadata) : null,
  );
}

/**
 * Update an existing agent session.
 * Only the provided fields are updated.
 */
export function updateAgentSession(
  id: string,
  updates: {
    container_id?: string;
    status?: string;
    last_health_check?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.container_id !== undefined) {
    fields.push('container_id = ?');
    values.push(updates.container_id);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_health_check !== undefined) {
    fields.push('last_health_check = ?');
    values.push(updates.last_health_check);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(JSON.stringify(updates.metadata));
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

/**
 * Get all active agent sessions (status = 'active').
 * Used by HealthChecker to determine which containers to monitor.
 */
export function getActiveSessions(): AgentSession[] {
  return stmtGetActiveSessions.all() as AgentSession[];
}

/**
 * End an agent session by setting status to 'ended'.
 * Records the end time in metadata.
 */
export function endAgentSession(id: string): void {
  // Single UPDATE using json_set to avoid SELECT + parse + UPDATE roundtrip
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_sessions SET status = 'ended',
       metadata = json_set(COALESCE(metadata, '{}'), '$.ended_at', ?)
     WHERE id = ?`,
  ).run(now, id);
}

export function getAllSessions(): Record<string, string> {
  const rows = stmtGetAllSessions.all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Meeting accessors ---

/**
 * Create a new meeting record.
 */
export function createMeeting(meeting: {
  id: string;
  chat_id: string;
  agenda: string;
  moderator: string;
  participants: string[];
}): void {
  const now = new Date().toISOString();
  stmtCreateMeeting.run(
    meeting.id,
    meeting.chat_id,
    meeting.agenda,
    meeting.moderator,
    JSON.stringify(meeting.participants),
    now,
  );
}

/**
 * Update an existing meeting.
 */
export function updateMeeting(
  id: string,
  updates: {
    turns?: number;
    status?: string;
    ended_at?: string;
    summary?: string;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.turns !== undefined) {
    fields.push('turns = ?');
    values.push(updates.turns);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.ended_at !== undefined) {
    fields.push('ended_at = ?');
    values.push(updates.ended_at);
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE meetings SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

/**
 * Get all active meetings (status = 'active').
 */
export function getActiveMeetings(): Meeting[] {
  return stmtGetActiveMeetings.all() as Meeting[];
}

/**
 * End an active meeting.
 */
export function endMeeting(id: string, summary?: string): void {
  const now = new Date().toISOString();
  stmtEndMeeting.run(now, summary ?? null, id);
}

// --- Proactive message accessors ---

/**
 * Create a new proactive message record.
 */
export function createProactiveMessage(msg: {
  chat_id: string;
  topic: string;
  content: string;
}): number {
  const now = new Date().toISOString();
  const result = stmtCreateProactiveMessage.run(msg.chat_id, msg.topic, msg.content, now);
  return result.lastInsertRowid as number;
}

/**
 * Get all proactive messages for a specific group (chat).
 */
export function getProactiveMessagesForGroup(
  chatId: string,
): ProactiveMessage[] {
  return stmtGetProactiveMessagesForGroup.all(chatId) as ProactiveMessage[];
}

// --- Meeting turn accessors ---

/**
 * Create a new meeting turn record.
 */
export function createMeetingTurn(turn: {
  meeting_id: string;
  agent: string;
  content: string;
}): number {
  const now = new Date().toISOString();
  const result = stmtCreateMeetingTurn.run(turn.meeting_id, turn.agent, turn.content, now);
  return result.lastInsertRowid as number;
}

/**
 * Get all turns for a specific meeting.
 */
export function getMeetingTurns(meetingId: string): MeetingTurn[] {
  return stmtGetMeetingTurns.all(meetingId) as MeetingTurn[];
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = stmtGetRegisteredGroup.get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  stmtSetRegisteredGroup.run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = stmtGetAllRegisteredGroups.all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

