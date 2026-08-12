/**
 * Canonical table definitions are the single schema source. The same named
 * definitions build a fresh database and are compared against sqlite_schema
 * when an existing database is opened.
 */
export const CANONICAL_TABLE_DEFINITIONS: Readonly<Record<string, string>> = {
  files: `CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    space TEXT NOT NULL,
    checksum TEXT NOT NULL,
    source_updated_at INTEGER NOT NULL,
    size INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    document_id TEXT,
    revision TEXT,
    source_json TEXT,
    metadata_json TEXT
  )`,
  chunks: `CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    vector BLOB,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,
  tags: `CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    vector BLOB
  )`,
  file_tags: `CREATE TABLE file_tags (
    file_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (file_id, tag_id),
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  tag_residual_metrics: `CREATE TABLE tag_residual_metrics (
    tag_id INTEGER PRIMARY KEY,
    residual_energy REAL NOT NULL,
    neighbor_count INTEGER NOT NULL,
    residual_ratio REAL NOT NULL DEFAULT 0,
    model_sig TEXT NOT NULL DEFAULT '',
    artifact_sig TEXT NOT NULL DEFAULT '',
    algorithm_version TEXT NOT NULL DEFAULT '',
    config_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'computed',
    computed_at INTEGER NOT NULL,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  tag_derived_artifacts: `CREATE TABLE tag_derived_artifacts (
    artifact_sig TEXT PRIMARY KEY,
    artifact_type TEXT NOT NULL,
    model_sig TEXT NOT NULL,
    graph_generation TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    effective_config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  tag_pair_similarity: `CREATE TABLE tag_pair_similarity (
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,
    similarity REAL NOT NULL,
    model_sig TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (tag_a, tag_b),
    FOREIGN KEY(tag_a) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_b) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  tag_pair_similarity_status: `CREATE TABLE tag_pair_similarity_status (
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    artifact_sig TEXT NOT NULL,
    status TEXT NOT NULL,
    similarity REAL,
    min_similarity REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (tag_a, tag_b, artifact_sig),
    FOREIGN KEY(tag_a) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_b) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  tag_graph_artifacts: `CREATE TABLE tag_graph_artifacts (
    artifact_sig TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    graph_generation TEXT NOT NULL,
    model_sig TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    database_generation TEXT NOT NULL,
    provenance_generation TEXT NOT NULL,
    payload_codec TEXT NOT NULL DEFAULT 'gzip-json-v1',
    payload_checksum TEXT,
    payload BLOB,
    status TEXT NOT NULL,
    error_message TEXT,
    node_count INTEGER NOT NULL DEFAULT 0,
    edge_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER
  )`,
  kv_store: `CREATE TABLE kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    vector BLOB
  )`,
  propagation_history_state: `CREATE TABLE propagation_history_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL DEFAULT 0,
    total_mass REAL NOT NULL DEFAULT 0
  )`,
  propagation_history_edges: `CREATE TABLE propagation_history_edges (
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    total REAL NOT NULL CHECK (total >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY(source_id) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY(target_id) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  memory_relations: `CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY,
    from_key TEXT NOT NULL,
    to_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('source', 'derived')),
    confidence REAL NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 0,
    evidence TEXT,
    provenance_json TEXT,
    source_revision TEXT,
    algorithm_version TEXT,
    source_span_start INTEGER,
    source_span_end INTEGER,
    target_anchor TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'stale', 'rejected')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
};

export const CANONICAL_SCHEMA_VERSION = 3;

/** Named indexes are part of the canonical integrity contract. */
export const CANONICAL_INDEX_DEFINITIONS: Readonly<Record<string, string>> = {
  idx_files_space: "CREATE INDEX idx_files_space ON files(space)",
  idx_chunks_file: "CREATE INDEX idx_chunks_file ON chunks(file_id)",
  idx_file_tags_tag: "CREATE INDEX idx_file_tags_tag ON file_tags(tag_id)",
  idx_file_tags_composite:
    "CREATE INDEX idx_file_tags_composite ON file_tags(tag_id, file_id)",
  idx_files_document_id:
    "CREATE UNIQUE INDEX idx_files_document_id ON files(document_id) WHERE document_id IS NOT NULL",
  idx_tag_derived_artifacts_lookup:
    "CREATE INDEX idx_tag_derived_artifacts_lookup ON tag_derived_artifacts(artifact_type, model_sig, status)",
  idx_tag_pair_similarity_model:
    "CREATE INDEX idx_tag_pair_similarity_model ON tag_pair_similarity(model_sig)",
  idx_tag_pair_similarity_status_artifact:
    "CREATE INDEX idx_tag_pair_similarity_status_artifact ON tag_pair_similarity_status(artifact_sig, status)",
  idx_tag_pair_similarity_status_model:
    "CREATE INDEX idx_tag_pair_similarity_status_model ON tag_pair_similarity_status(model_sig)",
  idx_tag_graph_artifacts_status:
    "CREATE INDEX idx_tag_graph_artifacts_status ON tag_graph_artifacts(status, updated_at)",
  idx_propagation_history_edges_target:
    "CREATE INDEX idx_propagation_history_edges_target ON propagation_history_edges(target_id, updated_at)",
  idx_memory_relations_from:
    "CREATE INDEX idx_memory_relations_from ON memory_relations(from_key, active, status)",
  idx_memory_relations_to:
    "CREATE INDEX idx_memory_relations_to ON memory_relations(to_key, active, status)",
  idx_memory_relations_origin:
    "CREATE INDEX idx_memory_relations_origin ON memory_relations(origin, status, updated_at)",
};

export const SCHEMA_SQL = [
  ...Object.values(CANONICAL_TABLE_DEFINITIONS),
  "INSERT INTO propagation_history_state (id, sequence, total_mass) VALUES (1, 0, 0)",
  ...Object.values(CANONICAL_INDEX_DEFINITIONS),
].join(";\n");

export const CANONICAL_PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  files: ["id"],
  chunks: ["id"],
  tags: ["id"],
  file_tags: ["file_id", "tag_id"],
  tag_residual_metrics: ["tag_id"],
  tag_derived_artifacts: ["artifact_sig"],
  tag_pair_similarity: ["tag_a", "tag_b"],
  tag_pair_similarity_status: ["tag_a", "tag_b", "artifact_sig"],
  tag_graph_artifacts: ["artifact_sig"],
  kv_store: ["key"],
  propagation_history_state: ["id"],
  propagation_history_edges: ["source_id", "target_id"],
  memory_relations: ["id"],
};

export interface CanonicalForeignKey {
  from: string;
  table: string;
  to: string;
  onDelete: string;
}

export const CANONICAL_FOREIGN_KEYS: Readonly<
  Record<string, readonly CanonicalForeignKey[]>
> = {
  chunks: [{ from: "file_id", table: "files", to: "id", onDelete: "CASCADE" }],
  file_tags: [
    { from: "file_id", table: "files", to: "id", onDelete: "CASCADE" },
    { from: "tag_id", table: "tags", to: "id", onDelete: "CASCADE" },
  ],
  tag_residual_metrics: [
    { from: "tag_id", table: "tags", to: "id", onDelete: "CASCADE" },
  ],
  tag_pair_similarity: [
    { from: "tag_a", table: "tags", to: "id", onDelete: "CASCADE" },
    { from: "tag_b", table: "tags", to: "id", onDelete: "CASCADE" },
  ],
  tag_pair_similarity_status: [
    { from: "tag_a", table: "tags", to: "id", onDelete: "CASCADE" },
    { from: "tag_b", table: "tags", to: "id", onDelete: "CASCADE" },
  ],
  propagation_history_edges: [
    { from: "source_id", table: "tags", to: "id", onDelete: "CASCADE" },
    { from: "target_id", table: "tags", to: "id", onDelete: "CASCADE" },
  ],
};

export const CANONICAL_REQUIRED_CHECKS: Readonly<Record<string, readonly string[]>> = {
  propagation_history_state: ["check (id = 1)"],
  propagation_history_edges: ["check (total >= 0)"],
  memory_relations: [
    "check (origin in ('source', 'derived'))",
    "check (status in ('active', 'stale', 'rejected'))",
  ],
};

export const CANONICAL_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  files: [
    "id",
    "path",
    "space",
    "checksum",
    "source_updated_at",
    "size",
    "recorded_at",
    "indexed_at",
    "document_id",
    "revision",
    "source_json",
    "metadata_json",
  ],
  chunks: ["id", "file_id", "chunk_index", "content", "vector"],
  tags: ["id", "name", "vector"],
  file_tags: ["file_id", "tag_id", "position"],
  tag_residual_metrics: [
    "tag_id",
    "residual_energy",
    "neighbor_count",
    "residual_ratio",
    "model_sig",
    "artifact_sig",
    "algorithm_version",
    "config_hash",
    "status",
    "computed_at",
  ],
  tag_derived_artifacts: [
    "artifact_sig",
    "artifact_type",
    "model_sig",
    "graph_generation",
    "algorithm_version",
    "config_hash",
    "effective_config",
    "status",
    "created_at",
    "updated_at",
  ],
  tag_pair_similarity: ["tag_a", "tag_b", "similarity", "model_sig", "computed_at"],
  tag_pair_similarity_status: [
    "tag_a",
    "tag_b",
    "model_sig",
    "artifact_sig",
    "status",
    "similarity",
    "min_similarity",
    "computed_at",
  ],
  tag_graph_artifacts: [
    "artifact_sig",
    "schema_version",
    "algorithm_version",
    "graph_generation",
    "model_sig",
    "config_hash",
    "database_generation",
    "provenance_generation",
    "payload_codec",
    "payload_checksum",
    "payload",
    "status",
    "error_message",
    "node_count",
    "edge_count",
    "created_at",
    "updated_at",
    "published_at",
  ],
  kv_store: ["key", "value", "vector"],
  propagation_history_state: ["id", "sequence", "total_mass"],
  propagation_history_edges: ["source_id", "target_id", "total", "updated_at"],
  memory_relations: [
    "id",
    "from_key",
    "to_key",
    "kind",
    "origin",
    "confidence",
    "weight",
    "evidence",
    "provenance_json",
    "source_revision",
    "algorithm_version",
    "source_span_start",
    "source_span_end",
    "target_anchor",
    "status",
    "active",
    "created_at",
    "updated_at",
  ],
};

export const METADATA_GENERATION_KEY = "metadata_generation";
export const VECTOR_GENERATION_KEY = "vector_generation";
export const VECTOR_DIRTY_KEY = "vector_dirty";
export const RELATION_GENERATION_KEY = "relation_generation";
