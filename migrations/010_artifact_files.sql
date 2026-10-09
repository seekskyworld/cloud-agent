-- 文件元数据在数据库，对象内容由存储端口负责；旧 JSON 产物结构不变。
CREATE TABLE file_artifacts(id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id),invocation_id text NOT NULL,name text NOT NULL,media_type text NOT NULL,bytes integer NOT NULL,digest text NOT NULL,object_key text NOT NULL,store_id text NOT NULL,state text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,invocation_id,name));
CREATE INDEX file_artifact_expiry ON file_artifacts(store_id,expires_at);
