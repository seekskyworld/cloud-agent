ALTER TABLE tasks ADD COLUMN execution_pool text NOT NULL DEFAULT 'default';
ALTER TABLE tasks ADD COLUMN execution_labels text[] NOT NULL DEFAULT '{}';
CREATE INDEX tasks_pool_queue_idx ON tasks(execution_pool,available_at) WHERE status IN ('queued','retry_scheduled','running');
