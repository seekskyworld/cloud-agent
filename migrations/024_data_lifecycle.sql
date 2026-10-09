ALTER TABLE tasks ADD COLUMN retired_at timestamptz;
CREATE TABLE retention_audit(id bigserial PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id),policy_days integer NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE platform_maintenance(id boolean PRIMARY KEY DEFAULT true CHECK(id),enabled boolean NOT NULL DEFAULT false,reason text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO platform_maintenance(id) VALUES(true);
