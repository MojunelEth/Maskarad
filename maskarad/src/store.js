// Site data in SQLite, which is built into Node.js: accounts, sessions, videos, custom characters, support messages.
// The site takes no money: every user has their own fal.ai key, stored in the database only in encrypted form.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function createStore(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT,
      character_name TEXT,
      status TEXT NOT NULL,
      error TEXT,
      result_path TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS renders_user ON renders (user_id);
    CREATE TABLE IF NOT EXISTS custom_characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      image_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS custom_user ON custom_characters (user_id);
    CREATE TABLE IF NOT EXISTS character_generations (
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT,
      topic TEXT,
      message TEXT NOT NULL,
      video_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );
  `);

  // Databases from earlier versions: add the columns for the fal.ai key
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const [name, type] of [['fal_key', 'TEXT'], ['fal_key_hint', 'TEXT'], ['fal_key_at', 'INTEGER']]) {
    if (!userColumns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }

  const q = {
    userInsert: db.prepare('INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userPassword: db.prepare('UPDATE users SET password = ? WHERE id = ?'),
    userLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    userFalKey: db.prepare('UPDATE users SET fal_key = ?, fal_key_hint = ?, fal_key_at = ? WHERE id = ?'),

    sessionInsert: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionGet: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    sessionDeleteUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sessionPurge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    renderInsert: db.prepare("INSERT INTO renders (id, user_id, character_id, character_name, status, created_at) VALUES (?, ?, ?, ?, 'working', ?)"),
    renderFinish: db.prepare('UPDATE renders SET status = ?, error = ?, result_path = ?, finished_at = ? WHERE id = ?'),
    renderById: db.prepare('SELECT * FROM renders WHERE id = ?'),
    rendersOfUser: db.prepare('SELECT * FROM renders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
    rendersInterrupted: db.prepare("UPDATE renders SET status = 'failed', error = ?, finished_at = ? WHERE status = 'working'"),

    customInsert: db.prepare('INSERT INTO custom_characters (id, user_id, name, description, image_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    customById: db.prepare('SELECT * FROM custom_characters WHERE id = ?'),
    customOfUser: db.prepare('SELECT * FROM custom_characters WHERE user_id = ? ORDER BY created_at DESC'),
    customDelete: db.prepare('DELETE FROM custom_characters WHERE id = ? AND user_id = ?'),
    genInsert: db.prepare('INSERT INTO character_generations (user_id, created_at) VALUES (?, ?)'),
    genCount: db.prepare('SELECT COUNT(*) AS n FROM character_generations WHERE user_id = ? AND created_at > ?'),

    supportInsert: db.prepare('INSERT INTO support_requests (id, user_id, email, topic, message, video_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?)'),
    supportList: db.prepare('SELECT * FROM support_requests ORDER BY (status = \'open\') DESC, created_at DESC LIMIT 100'),
    supportClose: db.prepare("UPDATE support_requests SET status = 'closed' WHERE id = ?"),
  };

  const dayAgo = () => Date.now() - 24 * 60 * 60 * 1000;

  return {
    // Accounts
    createUser(email, passwordHash) {
      const id = randomUUID();
      q.userInsert.run(id, email, passwordHash, Date.now());
      return q.userById.get(id);
    },
    getUser: (id) => q.userById.get(id) || null,
    getUserByEmail: (email) => q.userByEmail.get(email) || null,
    setPassword: (userId, hash) => q.userPassword.run(hash, userId),
    touchLogin: (userId) => q.userLogin.run(Date.now(), userId),
    /** sealed is an already encrypted key; null removes the key. */
    setFalKey: (userId, sealed, hint) => q.userFalKey.run(sealed, sealed ? hint : null, sealed ? Date.now() : null, userId),

    // Sessions
    createSession: (tokenHash, userId, ttlMs) => q.sessionInsert.run(tokenHash, userId, Date.now(), Date.now() + ttlMs),
    getSession(tokenHash) {
      const s = q.sessionGet.get(tokenHash);
      if (!s) return null;
      if (s.expires_at < Date.now()) {
        q.sessionDelete.run(tokenHash);
        return null;
      }
      return s;
    },
    deleteSession: (tokenHash) => q.sessionDelete.run(tokenHash),
    deleteUserSessions: (userId) => q.sessionDeleteUser.run(userId),
    purgeSessions: () => q.sessionPurge.run(Date.now()),

    // Videos
    renderStarted: (id, userId, characterId, characterName) => q.renderInsert.run(id, userId, characterId, characterName, Date.now()),
    renderFinished: (id, { ok, error = null, resultPath = null }) => q.renderFinish.run(ok ? 'done' : 'failed', error, resultPath, Date.now(), id),
    getRender: (id) => q.renderById.get(id) || null,
    rendersOf: (userId, limit = 30) => q.rendersOfUser.all(userId, limit),
    markInterrupted: (message) => q.rendersInterrupted.run(message, Date.now()).changes,

    // Custom characters
    createCustom({ id = randomUUID(), userId, name, description, imagePath }) {
      q.customInsert.run(id, userId, name, description, imagePath, Date.now());
      return q.customById.get(id);
    },
    getCustom: (id) => q.customById.get(id) || null,
    customsOf: (userId) => q.customOfUser.all(userId),
    deleteCustom: (id, userId) => q.customDelete.run(id, userId).changes === 1,
    recordGeneration: (userId) => q.genInsert.run(userId, Date.now()),
    generationsToday: (userId) => q.genCount.get(userId, dayAgo()).n,

    // Support messages
    createSupport({ userId = null, email = null, topic = null, message, videoId = null }) {
      const id = randomUUID();
      q.supportInsert.run(id, userId, email, topic, message, videoId, Date.now());
      return id;
    },
    supportList: () => q.supportList.all(),
    closeSupport: (id) => q.supportClose.run(id).changes === 1,

    // Admin
    stats() {
      const day = dayAgo();
      return {
        users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
        usersToday: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').get(day).n,
        usersWithKey: db.prepare('SELECT COUNT(*) AS n FROM users WHERE fal_key IS NOT NULL').get().n,
        rendersTotal: db.prepare('SELECT status, COUNT(*) AS n FROM renders GROUP BY status').all(),
        rendersToday: db.prepare('SELECT status, COUNT(*) AS n FROM renders WHERE created_at > ? GROUP BY status').all(day),
        openSupport: db.prepare("SELECT COUNT(*) AS n FROM support_requests WHERE status = 'open'").get().n,
      };
    },
    close: () => db.close(),
  };
}
