'use strict';

const MetadataStore = require('../interfaces/metadata-store');

let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    Database = null;
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        diary_name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector BLOB,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        vector BLOB
    );
    CREATE TABLE IF NOT EXISTS file_tags (
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        vector BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
`;

/**
 * SQLite-backed metadata store using better-sqlite3.
 *
 * Consolidates schema initialization, file/chunk/tag CRUD, co-occurrence
 * matrix building, and health-check logic from modules/knowledgeBase/
 * (schemaManager.js, sqliteHealthManager.js, ingestionPipeline.js).
 *
 * All methods are async to satisfy the MetadataStore interface, but the
 * underlying better-sqlite3 calls are synchronous.
 */
class SqliteMetadataStore extends MetadataStore {
    /**
     * @param {object} config
     * @param {string} config.dbPath          - SQLite file path (or ':memory:')
     * @param {number} [config.dimension]     - Vector dimension (stored for reference)
     * @param {number} [config.busyTimeout]   - SQLite busy_timeout in ms (default 10000)
     * @param {number} [config.busyRetryDelay]- Delay between busy retries in ms (default 100)
     */
    constructor(config = {}) {
        super();

        if (!Database) {
            throw new Error(
                'better-sqlite3 is not available. Install it with: npm install better-sqlite3'
            );
        }

        this.dbPath = config.dbPath || ':memory:';
        this.dimension = config.dimension || null;
        this.busyTimeout = config.busyTimeout || 10000;
        this.busyRetryDelay = config.busyRetryDelay || 100;
        this._closed = false;

        this.db = new Database(this.dbPath);
        this._configureConnection();
        this._initializeSchema();
    }

    _configureConnection() {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma(`busy_timeout = ${this.busyTimeout}`);
    }

    _initializeSchema() {
        this.db.exec(SCHEMA_SQL);
    }

    // ── File CRUD ───────────────────────────────────────────────

    async upsertFile(fileMeta) {
        const now = Math.floor(Date.now() / 1000);
        const stmt = this.db.prepare(`
            INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                diary_name = excluded.diary_name,
                checksum = excluded.checksum,
                mtime = excluded.mtime,
                size = excluded.size,
                updated_at = excluded.updated_at
        `);
        stmt.run(
            fileMeta.path,
            fileMeta.diaryName,
            fileMeta.checksum,
            fileMeta.mtime,
            fileMeta.size,
            now
        );
        const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(fileMeta.path);
        return row ? row.id : null;
    }

    async getFileByPath(path) {
        return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) || null;
    }

    async getDistinctDiaryNames() {
        const rows = this.db.prepare(
            'SELECT DISTINCT diary_name FROM files WHERE diary_name != ?'
        ).all('');
        return rows.map(r => r.diary_name).filter(Boolean);
    }

    async getFileByChunkId(chunkId) {
        return this.db.prepare(`
            SELECT f.id, f.path, f.diary_name, f.checksum, f.mtime, f.size, f.updated_at
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.id = ?
        `).get(chunkId) || null;
    }

    async deleteFile(fileId) {
        this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    }

    // ── Chunk CRUD ──────────────────────────────────────────────

    async insertChunks(fileId, chunks) {
        if (!chunks || chunks.length === 0) return [];

        const delStmt = this.db.prepare('DELETE FROM chunks WHERE file_id = ?');
        const insertStmt = this.db.prepare(
            'INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, ?, ?, ?)'
        );

        const ids = this.db.transaction(() => {
            delStmt.run(fileId);
            const result = [];
            for (const chunk of chunks) {
                const info = insertStmt.run(
                    fileId,
                    chunk.chunkIndex,
                    chunk.content,
                    chunk.vector || null
                );
                result.push(info.lastInsertRowid);
            }
            return result;
        })();

        return ids;
    }

    async getChunksByFileId(fileId) {
        const rows = this.db.prepare(
            'SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE file_id = ? ORDER BY chunk_index'
        ).all(fileId);
        return rows.map(r => ({
            id: r.id,
            fileId: r.file_id,
            chunkIndex: r.chunk_index,
            content: r.content,
            vector: r.vector || null
        }));
    }

    async getChunkById(id) {
        const row = this.db.prepare(
            'SELECT id, file_id, chunk_index, content, vector FROM chunks WHERE id = ?'
        ).get(id);
        if (!row) return null;
        return {
            id: row.id,
            fileId: row.file_id,
            chunkIndex: row.chunk_index,
            content: row.content,
            vector: row.vector || null
        };
    }

    async getAllChunks() {
        const rows = this.db.prepare(
            'SELECT id, file_id, chunk_index, content FROM chunks ORDER BY id'
        ).all();
        return rows.map(r => ({
            id: r.id,
            fileId: r.file_id,
            chunkIndex: r.chunk_index,
            content: r.content
        }));
    }

    // ── Tag CRUD ────────────────────────────────────────────────

    async upsertTags(tags) {
        if (!tags || tags.length === 0) return [];

        const insertStmt = this.db.prepare(
            'INSERT OR IGNORE INTO tags (name, vector) VALUES (?, ?)'
        );
        const updateVectorStmt = this.db.prepare(
            'UPDATE tags SET vector = ? WHERE name = ?'
        );
        const getIdStmt = this.db.prepare('SELECT id FROM tags WHERE name = ?');

        const ids = this.db.transaction(() => {
            const result = [];
            for (const tag of tags) {
                insertStmt.run(tag.name, tag.vector || null);
                if (tag.vector) {
                    updateVectorStmt.run(tag.vector, tag.name);
                }
                const row = getIdStmt.get(tag.name);
                result.push(row.id);
            }
            return result;
        })();

        return ids;
    }

    async getTagByName(name) {
        const row = this.db.prepare('SELECT id, name, vector FROM tags WHERE name = ?').get(name);
        if (!row) return null;
        return { id: row.id, name: row.name, vector: row.vector || null };
    }

    async getAllTags() {
        const rows = this.db.prepare('SELECT id, name, vector FROM tags ORDER BY id').all();
        return rows.map(r => ({ id: r.id, name: r.name, vector: r.vector || null }));
    }

    // ── File-Tag associations ───────────────────────────────────

    async setFileTags(fileId, tagIds) {
        if (!tagIds || tagIds.length === 0) {
            this.db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(fileId);
            return;
        }

        const delStmt = this.db.prepare('DELETE FROM file_tags WHERE file_id = ?');
        const insertStmt = this.db.prepare(
            'INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)'
        );

        this.db.transaction(() => {
            delStmt.run(fileId);
            tagIds.forEach((tagId, index) => {
                insertStmt.run(fileId, tagId, index + 1);
            });
        })();
    }

    async getFileTags(fileId) {
        const rows = this.db.prepare(`
            SELECT t.id, t.name, ft.position
            FROM file_tags ft
            JOIN tags t ON ft.tag_id = t.id
            WHERE ft.file_id = ?
            ORDER BY ft.position
        `).all(fileId);
        return rows.map(r => ({ id: r.id, name: r.name, position: r.position }));
    }

    async getFileIdsByTagId(tagId) {
        const rows = this.db.prepare(
            'SELECT DISTINCT file_id FROM file_tags WHERE tag_id = ?'
        ).all(tagId);
        return rows.map(r => r.file_id);
    }

    // ── Co-occurrence ───────────────────────────────────────────

    async buildCooccurrenceMatrix() {
        const stmt = this.db.prepare(`
            SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
            FROM file_tags ft1
            JOIN file_tags ft2 ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
            GROUP BY ft1.tag_id, ft2.tag_id
        `);

        const matrix = new Map();
        for (const row of stmt.iterate()) {
            if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
            if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());

            matrix.get(row.tag1).set(row.tag2, row.weight);
            matrix.get(row.tag2).set(row.tag1, row.weight);
        }
        return matrix;
    }

    // ── KV store ────────────────────────────────────────────────

    async getKv(key) {
        const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    async setKv(key, value) {
        this.db.prepare(
            'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
        ).run(key, value);
    }

    // ── Health ──────────────────────────────────────────────────

    async checkpoint() {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    async healthCheck() {
        const issues = [];
        try {
            this.db.prepare('SELECT 1').get();
        } catch (e) {
            issues.push(e.message);
        }
        try {
            const row = this.db.prepare('PRAGMA quick_check').get();
            const result = row ? Object.values(row)[0] : 'ok';
            if (result !== 'ok') {
                issues.push(`quick_check: ${result}`);
            }
        } catch (e) {
            issues.push(`quick_check failed: ${e.message}`);
        }
        return { healthy: issues.length === 0, issues };
    }

    // ── Lifecycle ───────────────────────────────────────────────

    close() {
        if (this._closed) return;
        this._closed = true;
        try {
            this.db.close();
        } catch (_) {
            // Already closed or error during close - ignore
        }
    }
}

module.exports = SqliteMetadataStore;
