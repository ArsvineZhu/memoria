export const SCHEMA_SQL = `
    CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        space TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER,
        document_id TEXT,
        revision TEXT,
        source_json TEXT,
        metadata_json TEXT
    );
    CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector BLOB,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        vector BLOB
    );
    CREATE TABLE file_tags (
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE tag_residual_metrics (
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
    );
    CREATE TABLE tag_derived_artifacts (
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
    );
    CREATE TABLE tag_pair_similarity (
        tag_a INTEGER NOT NULL,
        tag_b INTEGER NOT NULL,
        similarity REAL NOT NULL,
        model_sig TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_a, tag_b),
        FOREIGN KEY(tag_a) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_b) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE tag_pair_similarity_status (
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
    );
    CREATE TABLE tag_graph_artifacts (
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
    );
    CREATE TABLE kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        vector BLOB
    );
    CREATE TABLE memory_relations (
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
    );
    CREATE INDEX idx_files_space ON files(space);
    CREATE INDEX idx_chunks_file ON chunks(file_id);
    CREATE INDEX idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX idx_file_tags_composite ON file_tags(tag_id, file_id);
    CREATE UNIQUE INDEX idx_files_document_id ON files(document_id) WHERE document_id IS NOT NULL;
    CREATE INDEX idx_tag_derived_artifacts_lookup ON tag_derived_artifacts(artifact_type, model_sig, status);
    CREATE INDEX idx_tag_pair_similarity_model ON tag_pair_similarity(model_sig);
    CREATE INDEX idx_tag_pair_similarity_status_artifact ON tag_pair_similarity_status(artifact_sig, status);
    CREATE INDEX idx_tag_pair_similarity_status_model ON tag_pair_similarity_status(model_sig);
    CREATE INDEX idx_tag_graph_artifacts_status ON tag_graph_artifacts(status, updated_at);
    CREATE INDEX idx_memory_relations_from ON memory_relations(from_key, active, status);
    CREATE INDEX idx_memory_relations_to ON memory_relations(to_key, active, status);
    CREATE INDEX idx_memory_relations_origin ON memory_relations(origin, status, updated_at);
`;

export const CANONICAL_SCHEMA_VERSION = 1;

export const CANONICAL_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  files: [
    "id",
    "path",
    "space",
    "checksum",
    "mtime",
    "size",
    "updated_at",
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
