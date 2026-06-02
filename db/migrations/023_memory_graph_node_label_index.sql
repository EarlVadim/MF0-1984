-- Add index on memory_graph_nodes.label to speed up LIKE queries
-- from _toolGetMemoryNodes (get_memory_nodes tool).
-- Full table scan on blob LIKE '%term%' remains without FTS5, but
-- label LIKE queries benefit significantly from this index.
CREATE INDEX IF NOT EXISTS idx_memory_graph_nodes_label ON memory_graph_nodes (label);
