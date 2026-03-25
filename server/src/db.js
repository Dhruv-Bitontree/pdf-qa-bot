import initSqlJs from "sql.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createDb(dbPath) {
  const resolvedPath =
    dbPath || path.join(__dirname, "..", "data", "pdf-qa.db");

  const SQL = await initSqlJs();
  let db;

  if (fs.existsSync(resolvedPath)) {
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Save database to file
  const saveDb = () => {
    const data = db.export();
    fs.writeFileSync(resolvedPath, data);
  };

  // Add better-sqlite3 compatible API
  const originalRun = db.run.bind(db);
  const originalExec = db.exec.bind(db);

  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      ai_title_short TEXT,
      ai_summary TEXT,
      file_size INTEGER NOT NULL,
      page_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'processing' CHECK(status IN ('processing','ready','error')),
      progress_percent REAL DEFAULT 0,
      processing_stage TEXT,
      status_message TEXT,
      chunks_total INTEGER DEFAULT 0,
      chunks_processed INTEGER DEFAULT 0,
      extracted_image_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      page_number INTEGER,
      start_offset INTEGER,
      end_offset INTEGER,
      chunk_type TEXT DEFAULT 'text' CHECK(chunk_type IN ('text','ocr_image','vision')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS term_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      tf REAL NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_term ON term_index(term);
    CREATE INDEX IF NOT EXISTS idx_term_chunk ON term_index(chunk_id);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      title TEXT DEFAULT 'New Conversation',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      sources TEXT,
      images TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS extracted_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      page_number INTEGER,
      image_path TEXT NOT NULL,
      mime_type TEXT DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      file_size INTEGER NOT NULL,
      source_type TEXT DEFAULT 'embedded' CHECK(source_type IN ('embedded','page_capture')),
      context_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_images_doc ON extracted_images(document_id);
    CREATE INDEX IF NOT EXISTS idx_extracted_images_doc_page ON extracted_images(document_id, page_number);
  `);

  // Add better-sqlite3 compatible prepare method
  const originalPrepare = db.prepare.bind(db);

  db.prepare = function (sql) {
    return {
      get: (...params) => {
        const stmt = originalPrepare(sql);
        stmt.bind(params);
        const result = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return result;
      },
      all: (...params) => {
        const results = [];
        const stmt = originalPrepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run: (...params) => {
        const stmt = originalPrepare(sql);
        stmt.bind(params);
        stmt.step();

        // Get changes and last insert rowid BEFORE freeing the statement
        const changes = db.getRowsModified();

        stmt.free();

        // Get last insert rowid immediately after execution
        const lastIdResult = db.exec("SELECT last_insert_rowid() as id");
        const lastId = lastIdResult[0]?.values[0]?.[0] || 0;

        saveDb();

        return {
          changes: changes,
          lastInsertRowid: lastId,
        };
      },
    };
  };

  // Override run and exec to auto-save
  db.run = function (...args) {
    const result = originalRun(...args);
    saveDb();
    return result;
  };

  db.exec = function (...args) {
    const result = originalExec(...args);
    saveDb();
    return result;
  };

  // Add close compatibility with better-sqlite3-style usage in tests.
  if (typeof db.close !== "function") {
    db.close = function () {
      saveDb();
      return undefined;
    };
  }

  // Ensure existing databases support vision chunk type without manual migration.
  migrateChunksTableForVisionType(db);
  migrateDocumentsTableForProgress(db);
  migrateExtractedImagesTable(db);
  migrateMessagesTableForImages(db);

  return db;
}

function hasColumn(db, tableName, columnName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((col) => String(col.name) === columnName);
}

function migrateDocumentsTableForProgress(db) {
  const additions = [
    ["ai_title_short", "TEXT"],
    ["ai_summary", "TEXT"],
    ["progress_percent", "REAL DEFAULT 0"],
    ["processing_stage", "TEXT"],
    ["status_message", "TEXT"],
    ["chunks_total", "INTEGER DEFAULT 0"],
    ["chunks_processed", "INTEGER DEFAULT 0"],
    ["extracted_image_count", "INTEGER DEFAULT 0"],
  ];

  for (const [name, definition] of additions) {
    if (!hasColumn(db, "documents", name)) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
    }
  }
}

function migrateExtractedImagesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extracted_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      page_number INTEGER,
      image_path TEXT NOT NULL,
      mime_type TEXT DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      file_size INTEGER NOT NULL,
      source_type TEXT DEFAULT 'embedded' CHECK(source_type IN ('embedded','page_capture')),
      context_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_images_doc ON extracted_images(document_id);
    CREATE INDEX IF NOT EXISTS idx_extracted_images_doc_page ON extracted_images(document_id, page_number);
  `);

  if (!hasColumn(db, "extracted_images", "context_text")) {
    db.exec("ALTER TABLE extracted_images ADD COLUMN context_text TEXT");
  }
}

function migrateMessagesTableForImages(db) {
  if (!hasColumn(db, "messages", "images")) {
    db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
  }
}

/**
 * Migrate legacy chunks table constraint:
 *   CHECK(chunk_type IN ('text','ocr_image'))
 * to:
 *   CHECK(chunk_type IN ('text','ocr_image','vision'))
 */
function migrateChunksTableForVisionType(db) {
  try {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'",
      )
      .get();

    const tableSql = String(row?.sql || "").toLowerCase();
    if (!tableSql) {
      return;
    }

    if (tableSql.includes("'vision'")) {
      return;
    }

    console.log("[db] Migrating chunks table to allow vision chunk_type...");

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN TRANSACTION");

    db.exec(`
      CREATE TABLE chunks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        page_number INTEGER,
        start_offset INTEGER,
        end_offset INTEGER,
        chunk_type TEXT DEFAULT 'text' CHECK(chunk_type IN ('text','ocr_image','vision')),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      INSERT INTO chunks_new (
        id,
        document_id,
        chunk_index,
        content,
        page_number,
        start_offset,
        end_offset,
        chunk_type,
        created_at
      )
      SELECT
        id,
        document_id,
        chunk_index,
        content,
        page_number,
        start_offset,
        end_offset,
        chunk_type,
        created_at
      FROM chunks;

      DROP TABLE chunks;
      ALTER TABLE chunks_new RENAME TO chunks;
    `);

    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");

    console.log("[db] Chunks table migration complete.");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
    } catch {
      // Ignore rollback errors
    }
    console.error(
      "[db] Failed to migrate chunks table for vision support:",
      err.message,
    );
  }
}
