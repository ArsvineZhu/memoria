'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SqliteMetadataStore =
    require('../../src/providers/sqlite-metadata-store');

function makeBuf(arr) {
    const f32 = new Float32Array(arr);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function makeStore(dbPath) {
    return new SqliteMetadataStore({
        dbPath: dbPath || ':memory:',
        dimension: 4,
        busyTimeout: 5000
    });
}

// ── Constructor & schema ───────────────────────────────────────

test('SqliteMetadataStore can be instantiated with :memory:', () => {
    const store = makeStore();
    assert.ok(store);
    assert.strictEqual(store.dbPath, ':memory:');
    assert.strictEqual(store.dimension, 4);
    store.close();
});

test('Schema tables are created on construction', () => {
    const store = makeStore();
    const tables = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    for (const t of ['files', 'chunks', 'tags', 'file_tags', 'kv_store']) {
        assert.ok(tables.includes(t), `table ${t} should exist`);
    }
    store.close();
});

test('foreign_keys pragma is enabled', () => {
    const store = makeStore();
    const row = store.db.prepare('PRAGMA foreign_keys').get();
    assert.strictEqual(row.foreign_keys, 1);
    store.close();
});

// ── File CRUD ──────────────────────────────────────────────────

test('upsertFile inserts a new file and returns its id', async () => {
    const store = makeStore();
    const id = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    assert.ok(typeof id === 'number');
    assert.ok(id > 0);
    store.close();
});

test('upsertFile updates an existing file (same path -> same id)', async () => {
    const store = makeStore();
    const meta = {
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    };
    const id1 = await store.upsertFile(meta);
    const id2 = await store.upsertFile({
        ...meta,
        checksum: 'def456',
        mtime: 1700000001,
        size: 2048
    });
    assert.strictEqual(id1, id2);
    store.close();
});

test('getFileByPath returns the file record', async () => {
    const store = makeStore();
    await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    const file = await store.getFileByPath('/diary/note1.md');
    assert.ok(file);
    assert.strictEqual(file.path, '/diary/note1.md');
    assert.strictEqual(file.diary_name, 'diary1');
    assert.strictEqual(file.checksum, 'abc123');
    store.close();
});

test('getFileByPath returns null for non-existent path', async () => {
    const store = makeStore();
    const file = await store.getFileByPath('/nonexistent.md');
    assert.strictEqual(file, null);
    store.close();
});

test('deleteFile removes the file record', async () => {
    const store = makeStore();
    const id = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    await store.deleteFile(id);
    const file = await store.getFileByPath('/diary/note1.md');
    assert.strictEqual(file, null);
    store.close();
});

// ── Chunk CRUD ─────────────────────────────────────────────────

test('insertChunks inserts chunks and returns their ids', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    const ids = await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'hello', vector: makeBuf([1, 0, 0, 0]) },
        { chunkIndex: 1, content: 'world', vector: makeBuf([0, 1, 0, 0]) }
    ]);
    assert.strictEqual(ids.length, 2);
    assert.ok(ids.every(id => typeof id === 'number' && id > 0));
    store.close();
});

test('insertChunks replaces old chunks for the same file', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'old1', vector: null },
        { chunkIndex: 1, content: 'old2', vector: null }
    ]);
    const ids2 = await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'new1', vector: null }
    ]);
    const chunks = await store.getChunksByFileId(fileId);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].content, 'new1');
    assert.strictEqual(ids2.length, 1);
    store.close();
});

test('getChunksByFileId returns chunks ordered by chunk_index', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    await store.insertChunks(fileId, [
        { chunkIndex: 2, content: 'c', vector: null },
        { chunkIndex: 0, content: 'a', vector: null },
        { chunkIndex: 1, content: 'b', vector: null }
    ]);
    const chunks = await store.getChunksByFileId(fileId);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(chunks[0].chunkIndex, 0);
    assert.strictEqual(chunks[1].chunkIndex, 1);
    assert.strictEqual(chunks[2].chunkIndex, 2);
    store.close();
});

test('getChunksByFileId returns empty array for file with no chunks', async () => {
    const store = makeStore();
    const chunks = await store.getChunksByFileId(99999);
    assert.deepStrictEqual(chunks, []);
    store.close();
});

test('getChunkById returns a single chunk', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    const ids = await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'hello', vector: makeBuf([1, 2, 3, 4]) }
    ]);
    const chunk = await store.getChunkById(ids[0]);
    assert.ok(chunk);
    assert.strictEqual(chunk.content, 'hello');
    assert.strictEqual(chunk.chunkIndex, 0);
    assert.ok(Buffer.isBuffer(chunk.vector));
    store.close();
});

test('getChunkById returns null for non-existent id', async () => {
    const store = makeStore();
    const chunk = await store.getChunkById(99999);
    assert.strictEqual(chunk, null);
    store.close();
});

test('chunk vector roundtrip preserves Float32 data', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md',
        diaryName: 'diary1',
        checksum: 'abc123',
        mtime: 1700000000,
        size: 1024
    });
    const original = [1.5, -2.3, 3.14, 0.0];
    const ids = await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'vec', vector: makeBuf(original) }
    ]);
    const chunk = await store.getChunkById(ids[0]);
    const f32 = new Float32Array(
        chunk.vector.buffer,
        chunk.vector.byteOffset,
        chunk.vector.byteLength / 4
    );
    assert.strictEqual(f32.length, 4);
    assert.ok(Math.abs(f32[0] - 1.5) < 1e-6);
    assert.ok(Math.abs(f32[1] - (-2.3)) < 1e-6);
    assert.ok(Math.abs(f32[2] - 3.14) < 1e-6);
    assert.ok(Math.abs(f32[3] - 0.0) < 1e-6);
    store.close();
});

// ── Tag CRUD ───────────────────────────────────────────────────

test('upsertTags inserts new tags and returns their ids', async () => {
    const store = makeStore();
    const ids = await store.upsertTags([
        { name: 'tag1', vector: makeBuf([1, 0, 0, 0]) },
        { name: 'tag2', vector: makeBuf([0, 1, 0, 0]) }
    ]);
    assert.strictEqual(ids.length, 2);
    assert.ok(ids[0] !== ids[1]);
    store.close();
});

test('upsertTags is idempotent for existing tag names', async () => {
    const store = makeStore();
    const ids1 = await store.upsertTags([
        { name: 'tag1', vector: makeBuf([1, 0, 0, 0]) }
    ]);
    const ids2 = await store.upsertTags([
        { name: 'tag1', vector: makeBuf([0, 1, 0, 0]) }
    ]);
    assert.strictEqual(ids1[0], ids2[0]);
    store.close();
});

test('upsertTags updates vector for existing tag', async () => {
    const store = makeStore();
    const newVec = makeBuf([1, 0, 0, 0]);
    await store.upsertTags([{ name: 'tag1', vector: newVec }]);
    await store.upsertTags([{ name: 'tag1', vector: makeBuf([0, 1, 0, 0]) }]);
    const tag = await store.getTagByName('tag1');
    assert.ok(tag);
    const f32 = new Float32Array(
        tag.vector.buffer, tag.vector.byteOffset, tag.vector.byteLength / 4
    );
    assert.ok(Math.abs(f32[1] - 1) < 1e-6);
    assert.ok(Math.abs(f32[0] - 0) < 1e-6);
    store.close();
});

test('upsertTags handles null vectors', async () => {
    const store = makeStore();
    const ids = await store.upsertTags([{ name: 'tag1', vector: null }]);
    assert.strictEqual(ids.length, 1);
    const tag = await store.getTagByName('tag1');
    assert.strictEqual(tag.vector, null);
    store.close();
});

test('upsertTags returns empty array for empty input', async () => {
    const store = makeStore();
    const ids = await store.upsertTags([]);
    assert.deepStrictEqual(ids, []);
    store.close();
});

test('getTagByName returns the tag record', async () => {
    const store = makeStore();
    await store.upsertTags([{ name: 'tag1', vector: null }]);
    const tag = await store.getTagByName('tag1');
    assert.ok(tag);
    assert.strictEqual(tag.name, 'tag1');
    store.close();
});

test('getTagByName returns null for non-existent tag', async () => {
    const store = makeStore();
    const tag = await store.getTagByName('nonexistent');
    assert.strictEqual(tag, null);
    store.close();
});

test('getAllTags returns all tags', async () => {
    const store = makeStore();
    await store.upsertTags([
        { name: 'tag1', vector: null },
        { name: 'tag2', vector: null },
        { name: 'tag3', vector: null }
    ]);
    const tags = await store.getAllTags();
    assert.strictEqual(tags.length, 3);
    const names = tags.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['tag1', 'tag2', 'tag3']);
    store.close();
});

test('getAllTags returns empty array when no tags exist', async () => {
    const store = makeStore();
    const tags = await store.getAllTags();
    assert.deepStrictEqual(tags, []);
    store.close();
});

// ── File-Tag associations ──────────────────────────────────────

test('setFileTags associates tags with a file', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    const tagIds = await store.upsertTags([
        { name: 'tag1', vector: null },
        { name: 'tag2', vector: null }
    ]);
    await store.setFileTags(fileId, tagIds);
    const tags = await store.getFileTags(fileId);
    assert.strictEqual(tags.length, 2);
    store.close();
});

test('setFileTags replaces old associations', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    const ids1 = await store.upsertTags([
        { name: 'tag1', vector: null },
        { name: 'tag2', vector: null },
        { name: 'tag3', vector: null }
    ]);
    await store.setFileTags(fileId, ids1);
    await store.setFileTags(fileId, [ids1[0]]);
    const tags = await store.getFileTags(fileId);
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].name, 'tag1');
    store.close();
});

test('setFileTags with empty array clears all associations', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    const tagIds = await store.upsertTags([
        { name: 'tag1', vector: null }
    ]);
    await store.setFileTags(fileId, tagIds);
    await store.setFileTags(fileId, []);
    const tags = await store.getFileTags(fileId);
    assert.strictEqual(tags.length, 0);
    store.close();
});

test('getFileTags returns tags ordered by position', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    const ids = await store.upsertTags([
        { name: 'alpha', vector: null },
        { name: 'beta', vector: null },
        { name: 'gamma', vector: null }
    ]);
    // Set in reverse order
    await store.setFileTags(fileId, [ids[2], ids[1], ids[0]]);
    const tags = await store.getFileTags(fileId);
    assert.strictEqual(tags[0].name, 'gamma');
    assert.strictEqual(tags[1].name, 'beta');
    assert.strictEqual(tags[2].name, 'alpha');
    store.close();
});

test('getFileTags returns empty array for file with no tags', async () => {
    const store = makeStore();
    const tags = await store.getFileTags(99999);
    assert.deepStrictEqual(tags, []);
    store.close();
});

// ── Co-occurrence matrix ───────────────────────────────────────

test('buildCooccurrenceMatrix returns empty map with no data', async () => {
    const store = makeStore();
    const matrix = await store.buildCooccurrenceMatrix();
    assert.ok(matrix instanceof Map);
    assert.strictEqual(matrix.size, 0);
    store.close();
});

test('buildCooccurrenceMatrix builds symmetric matrix from file_tags', async () => {
    const store = makeStore();

    // File 1 has tags A and B (A-B co-occur once)
    const f1 = await store.upsertFile({
        path: '/f1.md', diaryName: 'd1', checksum: 'c1', mtime: 1, size: 1
    });
    // File 2 has tags A, B, and C (A-B co-occur twice, A-C once, B-C once)
    const f2 = await store.upsertFile({
        path: '/f2.md', diaryName: 'd1', checksum: 'c2', mtime: 2, size: 2
    });

    const tagIds = await store.upsertTags([
        { name: 'A', vector: null },
        { name: 'B', vector: null },
        { name: 'C', vector: null }
    ]);
    const [aId, bId, cId] = tagIds;

    await store.setFileTags(f1, [aId, bId]);
    await store.setFileTags(f2, [aId, bId, cId]);

    const matrix = await store.buildCooccurrenceMatrix();

    // A-B should have weight 2 (both files)
    assert.strictEqual(matrix.get(aId).get(bId), 2);
    assert.strictEqual(matrix.get(bId).get(aId), 2);
    // A-C should have weight 1 (only file 2)
    assert.strictEqual(matrix.get(aId).get(cId), 1);
    assert.strictEqual(matrix.get(cId).get(aId), 1);
    // B-C should have weight 1 (only file 2)
    assert.strictEqual(matrix.get(bId).get(cId), 1);
    assert.strictEqual(matrix.get(cId).get(bId), 1);
    store.close();
});

test('buildCooccurrenceMatrix does not create self-loops', async () => {
    const store = makeStore();
    const f1 = await store.upsertFile({
        path: '/f1.md', diaryName: 'd1', checksum: 'c1', mtime: 1, size: 1
    });
    const [aId] = await store.upsertTags([{ name: 'A', vector: null }]);
    await store.setFileTags(f1, [aId]);

    const matrix = await store.buildCooccurrenceMatrix();
    // A single tag in a file produces no co-occurrence edges
    assert.strictEqual(matrix.size, 0);
    store.close();
});

// ── KV store ───────────────────────────────────────────────────

test('setKv + getKv roundtrip', async () => {
    const store = makeStore();
    await store.setKv('epa_cache', '{"v":1}');
    const val = await store.getKv('epa_cache');
    assert.strictEqual(val, '{"v":1}');
    store.close();
});

test('getKv returns null for non-existent key', async () => {
    const store = makeStore();
    const val = await store.getKv('nonexistent');
    assert.strictEqual(val, null);
    store.close();
});

test('setKv overwrites existing value', async () => {
    const store = makeStore();
    await store.setKv('key1', 'old');
    await store.setKv('key1', 'new');
    const val = await store.getKv('key1');
    assert.strictEqual(val, 'new');
    store.close();
});

// ── Checkpoint & healthCheck ───────────────────────────────────

test('checkpoint does not throw', async () => {
    const store = makeStore();
    await store.checkpoint();
    // No assertion needed - just verify it doesn't throw
    store.close();
});

test('healthCheck returns healthy on a fresh database', async () => {
    const store = makeStore();
    const result = await store.healthCheck();
    assert.strictEqual(result.healthy, true);
    assert.deepStrictEqual(result.issues, []);
    store.close();
});

// ── Cascade delete ─────────────────────────────────────────────

test('deleteFile cascades to chunks', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    await store.insertChunks(fileId, [
        { chunkIndex: 0, content: 'a', vector: null },
        { chunkIndex: 1, content: 'b', vector: null }
    ]);
    let chunks = await store.getChunksByFileId(fileId);
    assert.strictEqual(chunks.length, 2);

    await store.deleteFile(fileId);
    chunks = await store.getChunksByFileId(fileId);
    assert.strictEqual(chunks.length, 0);
    store.close();
});

test('deleteFile cascades to file_tags', async () => {
    const store = makeStore();
    const fileId = await store.upsertFile({
        path: '/diary/note1.md', diaryName: 'd1',
        checksum: 'c1', mtime: 1, size: 1
    });
    const tagIds = await store.upsertTags([
        { name: 'tag1', vector: null },
        { name: 'tag2', vector: null }
    ]);
    await store.setFileTags(fileId, tagIds);

    let tags = await store.getFileTags(fileId);
    assert.strictEqual(tags.length, 2);

    await store.deleteFile(fileId);
    tags = await store.getFileTags(fileId);
    assert.strictEqual(tags.length, 0);

    // Tags themselves should still exist
    const allTags = await store.getAllTags();
    assert.strictEqual(allTags.length, 2);
    store.close();
});

// ── Close ──────────────────────────────────────────────────────

test('close closes the database connection', () => {
    const store = makeStore();
    store.close();
    assert.strictEqual(store._closed, true);
});

test('close is idempotent', () => {
    const store = makeStore();
    store.close();
    store.close();
    assert.strictEqual(store._closed, true);
});

// ── File-based database ────────────────────────────────────────

test('Works with a file-based database', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-sqlite-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    try {
        const store = new SqliteMetadataStore({
            dbPath,
            dimension: 4,
            busyTimeout: 5000
        });

        const id = await store.upsertFile({
            path: '/diary/note1.md', diaryName: 'd1',
            checksum: 'c1', mtime: 1, size: 1
        });
        assert.ok(id > 0);

        await store.insertChunks(id, [
            { chunkIndex: 0, content: 'hello', vector: makeBuf([1, 2, 3, 4]) }
        ]);

        store.close();

        // Reopen and verify data persisted
        const store2 = new SqliteMetadataStore({
            dbPath,
            dimension: 4,
            busyTimeout: 5000
        });
        const file = await store2.getFileByPath('/diary/note1.md');
        assert.ok(file);
        assert.strictEqual(file.checksum, 'c1');

        const chunks = await store2.getChunksByFileId(file.id);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].content, 'hello');

        store2.close();
    } finally {
        try {
            for (const f of fs.readdirSync(tmpDir)) {
                fs.unlinkSync(path.join(tmpDir, f));
            }
            fs.rmdirSync(tmpDir);
        } catch (_) {}
    }
});
