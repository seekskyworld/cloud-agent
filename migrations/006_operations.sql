CREATE TABLE loop_health (
  id text NOT NULL,
  kind text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  last_success timestamptz,
  error text,
  PRIMARY KEY(id,kind)
);
CREATE INDEX loop_health_recent ON loop_health(kind,seen_at);
