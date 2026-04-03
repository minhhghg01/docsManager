const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');

let _instance = null;
let _saveTimer = null;

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const data = _instance._raw.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 200);
}

function saveSync() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (!_instance) return;
  const data = _instance._raw.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function flatParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function makePrepared(rawDb, sql) {
  const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql);

  return {
    run(...params) {
      const flat = flatParams(params);
      const stmt = rawDb.prepare(sql);
      if (flat.length) stmt.bind(flat);
      stmt.step();
      stmt.free();
      const rid = rawDb.prepare('SELECT last_insert_rowid() AS id');
      rid.step();
      const lastInsertRowid = rid.getAsObject().id;
      rid.free();
      const info = {
        changes: rawDb.getRowsModified(),
        lastInsertRowid
      };
      if (isWrite) scheduleSave();
      return info;
    },
    get(...params) {
      const flat = flatParams(params);
      const stmt = rawDb.prepare(sql);
      if (flat.length) stmt.bind(flat);
      let row;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row || undefined;
    },
    all(...params) {
      const flat = flatParams(params);
      const stmt = rawDb.prepare(sql);
      if (flat.length) stmt.bind(flat);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
  };
}

function createInstance(rawDb) {
  return {
    _raw: rawDb,
    exec(sql) {
      rawDb.run(sql);
      scheduleSave();
    },
    pragma(str) {
      try { rawDb.run(`PRAGMA ${str}`); } catch { /* ignore */ }
    },
    prepare(sql) {
      return makePrepared(rawDb, sql);
    },
    close() {
      saveSync();
      rawDb.close();
    }
  };
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'khoa')),
      khoa_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source_label TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT,
      is_public INTEGER NOT NULL DEFAULT 0,
      owner_khoa_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      pdf_cache_filename TEXT,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      khoa_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      UNIQUE(document_id, khoa_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      UNIQUE(document_id, tag)
    )
  `);
}

async function initDb() {
  if (_instance) return _instance;
  const SQL = await initSqlJs();
  let rawDb;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    rawDb = new SQL.Database(buf);
  } else {
    rawDb = new SQL.Database();
  }
  _instance = createInstance(rawDb);
  _instance.pragma('foreign_keys = ON');
  initSchema(_instance);
  saveSync();
  return _instance;
}

/**
 * Proxy: require('../db') trả về object giống better-sqlite3.
 * Gọi db.initDb() (async) 1 lần ở server.js trước khi listen.
 * Sau đó db.prepare / db.exec… hoạt động đồng bộ bình thường.
 */
const proxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'initDb') return initDb;
      if (prop === 'dbPath') return dbPath;
      if (!_instance) {
        throw new Error(
          'DB chưa khởi tạo — gọi await db.initDb() trong server.js trước'
        );
      }
      const val = _instance[prop];
      return typeof val === 'function' ? val.bind(_instance) : val;
    }
  }
);

module.exports = proxy;
