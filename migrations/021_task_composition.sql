ALTER TABLE tasks ADD COLUMN parent_id uuid REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN execution_scope text[];
CREATE INDEX tasks_parent_idx ON tasks(parent_id);
CREATE TABLE task_groups(step_id uuid PRIMARY KEY REFERENCES steps(id),parent_id uuid NOT NULL REFERENCES tasks(id),child_ids uuid[] NOT NULL,settled boolean NOT NULL DEFAULT false);
