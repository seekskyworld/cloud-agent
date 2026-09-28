ALTER TABLE task_groups ADD COLUMN usage jsonb NOT NULL DEFAULT '{"cost_usd":0,"model_calls":0,"tool_calls":0,"execution_ms":0}';
