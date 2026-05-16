-- Migration 012: semantic embeddings for memory_graph_nodes
-- Adds a BLOB column for storing a Float32 vector produced by pplx-embed-v1-4b.
-- Idempotent: the ALTER is skipped if the column already exists (handled in migrations.mjs).
-- embedding_model stores which model produced the vector so stale rows can be
-- detected and re-indexed when the model changes.

ALTER TABLE memory_graph_nodes ADD COLUMN embedding      BLOB;
ALTER TABLE memory_graph_nodes ADD COLUMN embedding_model TEXT;
