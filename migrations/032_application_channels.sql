-- 可信宿主通知复用唯一发件队列；不能携带外部等待或冒充任务通知。
ALTER TABLE mail_outbox ADD COLUMN system_policy text;
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_origin;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_origin CHECK (
 (system_policy IS NULL AND business_policy IS NULL AND task_id IS NOT NULL AND notification_key IS NOT NULL AND task_status IS NOT NULL)
 OR (system_policy IS NULL AND business_policy IS NOT NULL AND task_id IS NULL AND policy_version IS NOT NULL AND command_key IS NOT NULL AND request_hash IS NOT NULL AND actor_id IS NOT NULL AND source_task IS NOT NULL)
 OR (system_policy IS NOT NULL AND business_policy IS NULL AND task_id IS NULL AND source_task IS NULL AND wait_key IS NULL AND policy_version IS NOT NULL AND command_key IS NOT NULL AND request_hash IS NOT NULL)
);
CREATE UNIQUE INDEX mail_outbox_system_key ON mail_outbox(mailbox,system_policy,command_key) WHERE system_policy IS NOT NULL;
ALTER TABLE mail_outbox ADD COLUMN correlation_key text;
CREATE UNIQUE INDEX mail_outbox_correlation ON mail_outbox(mailbox,business_policy,correlation_key) WHERE correlation_key IS NOT NULL;

-- 注册范围由迁移账号预置；运行账号不可自行扩大初始能力或注册政策。
CREATE TABLE identity_registration_policies (
 id text PRIMARY KEY, workspace_id text NOT NULL, capabilities text[] NOT NULL,
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE identity_bindings (
 policy_id text NOT NULL REFERENCES identity_registration_policies(id), subject text NOT NULL,
 workspace_id text NOT NULL, principal_id text NOT NULL,
 PRIMARY KEY(policy_id,subject),
 FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id)
);
CREATE FUNCTION register_verified_identity(p_policy text,p_subject text,p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE policy public.identity_registration_policies%ROWTYPE; pid text;
BEGIN
 SELECT * INTO policy FROM public.identity_registration_policies WHERE id=p_policy AND enabled FOR SHARE;
 IF NOT FOUND OR length(p_subject) NOT BETWEEN 1 AND 254 OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'REGISTRATION_REJECTED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('identity-registration:'||p_policy||':'||p_subject,0));
 SELECT principal_id INTO pid FROM public.identity_bindings WHERE policy_id=p_policy AND subject=p_subject;
 IF FOUND THEN RETURN pid; END IF;
 pid := 'verified-'||md5(p_policy||':'||p_subject);
 INSERT INTO public.principals(id,workspace_id,token_hash,capabilities,role) VALUES(pid,policy.workspace_id,p_hash,policy.capabilities,'member');
 INSERT INTO public.identity_bindings VALUES(p_policy,p_subject,policy.workspace_id,pid);
 INSERT INTO public.administration_audit(workspace_id,actor_id,target_id,action,reason,after_access)
 VALUES(policy.workspace_id,'system:verified-registration',pid,'principal.created','Verified external subject',jsonb_build_object('role','member','capabilities',policy.capabilities));
 RETURN pid;
END $$;
REVOKE ALL ON FUNCTION register_verified_identity(text,text,text) FROM PUBLIC;
CREATE TABLE identity_email_challenges (
 id uuid PRIMARY KEY, policy_id text NOT NULL, email text NOT NULL, ip_hash text NOT NULL,
 code_hash text NOT NULL, sealed_code text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 used boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX identity_email_challenges_limits ON identity_email_challenges(policy_id,created_at);
