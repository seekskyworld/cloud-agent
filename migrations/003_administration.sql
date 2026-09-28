-- 角色限定工作区；旧身份保持原能力且不自动升级。管理写入由受限函数完成。
ALTER TABLE principals ADD COLUMN role text NOT NULL DEFAULT 'member'
  CHECK (role IN ('member','admin','superadmin'));
ALTER TABLE principals ADD COLUMN access_version integer NOT NULL DEFAULT 1;
CREATE TABLE administration_audit (
  id bigserial PRIMARY KEY, workspace_id text NOT NULL, actor_id text NOT NULL,
  target_id text NOT NULL, action text NOT NULL, reason text NOT NULL,
  before_access jsonb, after_access jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX administration_audit_workspace ON administration_audit(workspace_id,id);
CREATE TABLE administration_commands (
  workspace_id text NOT NULL, actor_id text NOT NULL, request_key text NOT NULL,
  request jsonb NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,request_key)
);
-- 运行账号不能直接写 principals 或审计；函数锁定工作区，复核操作者，再原子提交变更与审计。
-- 受信 API 绑定 actor；这不是向终端用户开放数据库连接的接口。
CREATE FUNCTION manage_principal_access(
  p_workspace text, p_actor text, p_target text, p_role text,
  p_capabilities text[], p_enabled boolean, p_version integer,
  p_reason text, p_key text, p_unusable_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor public.principals%ROWTYPE;
  target public.principals%ROWTYPE;
  command public.administration_commands%ROWTYPE;
  desired jsonb;
  before_value jsonb;
  result_value jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cloud-agent-access:' || p_workspace,0));
  SELECT * INTO actor FROM public.principals WHERE workspace_id=p_workspace AND id=p_actor FOR UPDATE;
  IF NOT FOUND OR NOT actor.enabled OR actor.role<>'superadmin' THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED';
  END IF;
  IF p_role NOT IN ('member','admin') OR p_role IS NULL OR p_capabilities IS NULL OR p_enabled IS NULL
    OR p_target IS NULL OR length(p_target) NOT BETWEEN 1 AND 120
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'INVALID_ACCESS_CHANGE';
  END IF;
  desired := jsonb_build_object('id',p_target,'role',p_role,'capabilities',p_capabilities,
    'enabled',p_enabled,'expectedVersion',p_version,'reason',p_reason);
  SELECT * INTO command FROM public.administration_commands
    WHERE workspace_id=p_workspace AND actor_id=p_actor AND request_key=p_key;
  IF FOUND THEN
    IF command.request<>desired THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    -- 只返回原结果，不重放写入，避免旧授权请求复活已撤销的管理员。
    RETURN command.result;
  END IF;
  SELECT * INTO target FROM public.principals WHERE workspace_id=p_workspace AND id=p_target FOR UPDATE;
  IF FOUND THEN
    IF target.role='superadmin' THEN RAISE EXCEPTION 'SUPERADMIN_PROTECTED'; END IF;
    IF p_version IS NULL OR target.access_version<>p_version THEN RAISE EXCEPTION 'ACCESS_VERSION_CONFLICT'; END IF;
    before_value := jsonb_build_object('id',target.id,'workspace_id',target.workspace_id,
      'role',target.role,'capabilities',target.capabilities,'enabled',target.enabled,'access_version',target.access_version);
    UPDATE public.principals SET role=p_role,capabilities=p_capabilities,enabled=p_enabled,
      access_version=access_version+1 WHERE workspace_id=p_workspace AND id=p_target RETURNING * INTO target;
  ELSE
    IF p_version IS NOT NULL THEN RAISE EXCEPTION 'PRINCIPAL_NOT_FOUND'; END IF;
    IF p_unusable_hash IS NULL OR p_unusable_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_ACCESS_CHANGE'; END IF;
    INSERT INTO public.principals(id,workspace_id,token_hash,role,capabilities,enabled)
      VALUES(p_target,p_workspace,p_unusable_hash,p_role,p_capabilities,p_enabled) RETURNING * INTO target;
  END IF;
  result_value := jsonb_build_object('id',target.id,'workspace_id',target.workspace_id,
    'role',target.role,'capabilities',target.capabilities,'enabled',target.enabled,'access_version',target.access_version);
  INSERT INTO public.administration_audit(workspace_id,actor_id,target_id,action,reason,before_access,after_access)
    VALUES(p_workspace,p_actor,p_target,CASE WHEN before_value IS NULL THEN 'principal.created' ELSE 'principal.access_changed' END,
      p_reason,before_value,result_value);
  INSERT INTO public.administration_commands(workspace_id,actor_id,request_key,request,result)
    VALUES(p_workspace,p_actor,p_key,desired,result_value);
  RETURN result_value;
END $$;
REVOKE ALL ON FUNCTION manage_principal_access(text,text,text,text,text[],boolean,integer,text,text,text) FROM PUBLIC;
