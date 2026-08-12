import type BetterSqlite3 from "better-sqlite3";

import type { FileTagRow, TagMetadataInput, TagRow } from "../../types/metadata.js";

interface TagQueryRow {
  id: number;
  name: string;
  vector?: Buffer | null;
}

interface FileTagQueryRow {
  id: number;
  name: string;
  position: number;
}

/** SQL operations for tags and the file-to-tag association collection. */
export default class SqliteTagRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsertTags(tags: readonly TagMetadataInput[]): number[] {
    if (tags.length === 0) return [];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tags (name, vector) VALUES (?, ?)",
    );
    const update = this.db.prepare("UPDATE tags SET vector = ? WHERE name = ?");
    const getId = this.db.prepare("SELECT id FROM tags WHERE name = ?");
    return this.db.transaction(() => {
      const ids: number[] = [];
      for (const tag of tags) {
        insert.run(tag.name, tag.vector || null);
        if (tag.vector) update.run(tag.vector, tag.name);
        const row = getId.get(tag.name) as { id: number } | undefined;
        if (row) ids.push(Number(row.id));
      }
      return ids;
    })();
  }

  upsertTagsInTransaction(tags: readonly TagMetadataInput[]): {
    tagIds: number[];
    tagIdsByName: Map<string, number>;
  } {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tags (name, vector) VALUES (?, ?)",
    );
    const update = this.db.prepare("UPDATE tags SET vector = ? WHERE name = ?");
    const get = this.db.prepare("SELECT id FROM tags WHERE name = ?");
    const tagIds: number[] = [];
    const tagIdsByName = new Map<string, number>();
    for (const tag of tags) {
      insert.run(tag.name, tag.vector ?? null);
      if (tag.vector !== null) update.run(tag.vector, tag.name);
      const row = get.get(tag.name) as { id?: number } | undefined;
      if (row?.id == null) continue;
      const id = Number(row.id);
      tagIds.push(id);
      tagIdsByName.set(tag.name, id);
    }
    return { tagIds, tagIdsByName };
  }

  findTagIdWithVector(name: string): number | undefined {
    const row = this.db
      .prepare("SELECT id, vector FROM tags WHERE name = ?")
      .get(name) as { id?: number; vector?: Buffer | null } | undefined;
    return row?.vector != null && row.id != null ? Number(row.id) : undefined;
  }

  getFileTagIds(fileId: number): number[] {
    const rows = this.db
      .prepare("SELECT tag_id FROM file_tags WHERE file_id = ?")
      .all(fileId) as Array<{ tag_id: number }>;
    return rows.map((row) => Number(row.tag_id));
  }

  replaceFileTagRows(fileId: number, tagIds: readonly number[]): void {
    this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
    const insert = this.db.prepare(
      "INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
    );
    tagIds.forEach((tagId, index) => insert.run(fileId, tagId, index + 1));
  }

  findOrphanedTagIds(tagIds: readonly number[]): number[] {
    return tagIds.filter((tagId) => {
      const row = this.db
        .prepare("SELECT 1 AS present FROM file_tags WHERE tag_id = ? LIMIT 1")
        .get(tagId) as { present?: number } | undefined;
      return !row?.present;
    });
  }

  getTagByName(name: string): TagRow | null {
    const row = this.db
      .prepare("SELECT id, name, vector FROM tags WHERE name = ?")
      .get(name) as TagQueryRow | undefined;
    return row ? toTagRow(row) : null;
  }

  getAllTags(): TagRow[] {
    const rows = this.db
      .prepare("SELECT id, name, vector FROM tags ORDER BY id")
      .all() as TagQueryRow[];
    return rows.map(toTagRow);
  }

  getActiveTags(): TagRow[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.id, t.name, t.vector FROM tags t
         JOIN file_tags ft ON ft.tag_id = t.id ORDER BY t.id`,
      )
      .all() as TagQueryRow[];
    return rows.map(toTagRow);
  }

  setFileTags(fileId: number, tagIds: readonly number[]): void {
    const remove = this.db.prepare("DELETE FROM file_tags WHERE file_id = ?");
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)",
    );
    this.db.transaction(() => {
      remove.run(fileId);
      tagIds.forEach((tagId, index) => insert.run(fileId, tagId, index + 1));
    })();
  }

  getFileTags(fileId: number): FileTagRow[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, ft.position FROM file_tags ft
         JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id = ? ORDER BY ft.position`,
      )
      .all(fileId) as FileTagQueryRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, position: row.position }));
  }

  getFileIdsByTagId(tagId: number): number[] {
    const rows = this.db
      .prepare("SELECT DISTINCT file_id FROM file_tags WHERE tag_id = ?")
      .all(tagId) as Array<{ file_id: number }>;
    return rows.map((row) => row.file_id);
  }
}

function toTagRow(row: TagQueryRow): TagRow {
  return { id: row.id, name: row.name, vector: row.vector || null };
}
