/** 业务邮件复用 mail_outbox、发送循环与管理恢复；只从可信领域端口调用。 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  DataSchema,
  Problem,
  requireCapability,
  type ExecutionContext,
  type Principal,
} from "../contracts/index.js";
import { fingerprint } from "../contracts/fingerprint.js";
import { bounded } from "../contracts/lifecycle.js";
import type { IdentityService } from "../identity/service.js";
import { SignalStore } from "../persistence/signals.js";
import { MailStore, type OutboxRow } from "./store.js";
import type { MailMessage, MailDelivery } from "./contracts.js";
import type {
  BusinessMailInput,
  BusinessMailPolicy,
} from "./business-contracts.js";
const Input = z
  .object({
    key: z.string().min(1).max(200),
    correlationKey: z.string().min(1).max(200).optional(),
    recipient: z.email().transform((v) => v.toLowerCase()),
    subject: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    body: z.string().min(1).max(60000),
    replyTo: z
      .string()
      .max(998)
      .regex(/^<[^<>\s]+>$/)
      .optional(),
    purpose: z.enum(["reply", "notification", "service-request"]),
    waitKey: z.string().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.json()),
  })
  .strict();
export class BusinessMail {
  private policies = new Map<string, BusinessMailPolicy>();
  constructor(
    readonly store: MailStore,
    private identity: IdentityService,
    policies: readonly BusinessMailPolicy[],
  ) {
    const senders = new Set<string>();
    for (const policy of policies) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(policy.id) ||
        !/^\d+\.\d+\.\d+$/.test(policy.version) ||
        !policy.capability ||
        this.policies.has(policy.id)
      )
        throw new Error("MAIL_POLICY_INVALID");
      if (policy.receipt) {
        const sender = z.email().parse(policy.receipt.sender);
        if (
          sender !== sender.toLowerCase() ||
          senders.has(sender) ||
          !policy.receipt.principal
        )
          throw new Error("MAIL_RECEIPT_ROUTE_CONFLICT");
        senders.add(sender);
      }
      this.policies.set(policy.id, policy);
    }
  }
  /** 必须在 BusinessTransactions.run 的同一 client 中调用，key 沿用工具幂等键。 */
  async enqueue(
    client: PoolClient,
    context: ExecutionContext,
    policyId: string,
    raw: BusinessMailInput,
  ): Promise<string> {
    context.signal.throwIfAborted();
    await this.store.initialize();
    if (
      (
        await client.query<{ enabled: boolean }>(
          "SELECT public.runtime_maintenance_enabled() AS enabled",
        )
      ).rows[0]?.enabled
    )
      throw new Problem(503, "MAINTENANCE_ENABLED");
    const input = Input.parse(raw),
      policy = this.policy(policyId);
    if (Buffer.byteLength(JSON.stringify(input)) > 128000)
      throw new Problem(422, "MAIL_MESSAGE_TOO_LARGE");
    if (
      input.key !== context.idempotencyKey &&
      !input.key.startsWith(context.idempotencyKey + ":")
    )
      throw new Problem(400, "MAIL_STABLE_KEY_REQUIRED");
    if (context.principal.workspace_id !== this.store.settings.workspace)
      throw new Problem(403, "MAIL_WORKSPACE_MISMATCH");
    requireCapability(context.principal, policy.capability);
    requireCapability(context.principal, "mail:use");
    const current = (
      await client.query<Principal>(
        "SELECT * FROM public.runtime_lock_principals($1,ARRAY[$2])",
        [context.principal.workspace_id, context.principal.id],
      )
    ).rows[0];
    if (!current) throw new Problem(403, "IDENTITY_REVOKED");
    requireCapability(current, policy.capability);
    requireCapability(current, "mail:use");
    if (
      input.waitKey &&
      (!policy.receipt || input.recipient !== policy.receipt.sender)
    )
      throw new Problem(400, "MAIL_RECEIPT_BINDING_INVALID");
    await bounded(
      5000,
      (signal) =>
        policy.authorize(
          input,
          {
            ...current,
            capabilities: current.capabilities.filter((c) =>
              context.principal.capabilities.includes(c),
            ),
          },
          signal,
        ),
      context.signal,
    );
    // 与当前工具调用关联，不能用模型给出的 taskId 或其他用户任务入队。
    const task = await client.query(
      `SELECT t.id FROM public.tasks t JOIN public.runs r ON r.task_id=t.id AND r.lease_token=t.lease_token
       JOIN public.steps s ON s.task_id=t.id AND s.id=$3
       WHERE t.id=$1 AND r.id=$2 AND r.status='running' AND t.status='running' AND t.lease_until>now()
       AND t.workspace_id=$4 AND t.principal_id=$5 FOR UPDATE OF t`,
      [
        context.taskId,
        context.runId,
        context.invocationId,
        context.principal.workspace_id,
        context.principal.id,
      ],
    );
    if (!task.rowCount) throw new Problem(409, "LEASE_LOST");
    const digest = fingerprint({
      input,
      task: context.taskId,
      actor: context.principal.id,
      version: policy.version,
    });
    const result = await client.query<{ id: string; request_hash: string }>(
      `INSERT INTO public.mail_outbox(id,mailbox,business_policy,policy_version,command_key,request_hash,actor_id,source_task,wait_key,purpose,metadata,recipient,reply_to,subject,body,state,correlation_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(mailbox,business_policy,command_key) WHERE business_policy IS NOT NULL DO UPDATE SET command_key=EXCLUDED.command_key
       RETURNING id,request_hash`,
      [
        randomUUID(),
        this.store.id,
        policy.id,
        policy.version,
        input.key,
        digest,
        context.principal.id,
        context.taskId,
        input.waitKey ?? null,
        input.purpose,
        JSON.stringify(input.metadata),
        input.recipient,
        input.replyTo ?? "",
        input.subject,
        input.body,
        this.store.settings.sendEnabled ? "pending" : "draft",
        input.correlationKey ?? null,
      ],
    );
    const row = result.rows[0]!;
    if (row.request_hash !== digest)
      throw new Problem(409, "MAIL_COMMAND_CONFLICT");
    return row.id;
  }
  async prepare(row: OutboxRow, signal: AbortSignal): Promise<MailDelivery> {
    const policy = this.policy(row.business_policy!);
    if (policy.version !== row.policy_version)
      throw new Problem(409, "MAIL_POLICY_CHANGED");
    const principal = await this.identity.current(
      this.store.settings.workspace,
      row.actor_id!,
    );
    requireCapability(principal, policy.capability);
    requireCapability(principal, "mail:use");
    const task = (
      await this.store.db.pool.query<{
        status: string;
        execution_scope: string[] | null;
      }>(
        "SELECT status,execution_scope FROM tasks WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
        [row.source_task, principal.workspace_id, principal.id],
      )
    ).rows[0];
    if (
      !task ||
      ["cancelled", "failed"].includes(task.status) ||
      (row.wait_key && task.status === "succeeded") ||
      (task.execution_scope &&
        !task.execution_scope.includes(policy.capability))
    )
      throw new Problem(409, "MAIL_SOURCE_INACTIVE");
    const scoped = {
      ...principal,
      capabilities: principal.capabilities.filter(
        (c) => !task.execution_scope || task.execution_scope.includes(c),
      ),
    };
    await bounded(
      5000,
      (s) => policy.authorize(this.input(row), scoped, s),
      signal,
    );
    if (policy.authorizeDelivery) {
      await bounded(
        5000,
        (s) => policy.authorizeDelivery!(this.input(row), scoped, s),
        signal,
      );
    }
    return {
      id: row.id,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      replyTo: row.reply_to,
      purpose: row.purpose,
    };
  }
  /** 匹配的服务邮件不会进入用户指令或自动回复路径。 */
  async receive(message: MailMessage): Promise<boolean> {
    const policy = [...this.policies.values()].find(
      (p) => p.receipt?.sender === message.sender,
    );
    if (!policy) return false;
    if (!message.authenticated) throw new Problem(403, "MAIL_SENDER_UNTRUSTED");
    const related = message.inReplyTo
      ? (
          await this.store.db.pool.query<OutboxRow>(
            "SELECT * FROM public.mail_outbox WHERE mailbox=$1 AND business_policy=$2 AND recipient=$3 AND (provider_id=$4 OR '<'||id::text||'@cloud-agent.local>'=$4)",
            [this.store.id, policy.id, message.sender, message.inReplyTo],
          )
        ).rows[0]
      : undefined;
    const parsed = z
      .object({ key: z.string().min(1).max(200), response: DataSchema })
      .strict()
      .parse(
        await policy.receipt!.parse(
          message,
          related ? this.input(related) : undefined,
        ),
      );
    const eventKey = message.deduplicationId ?? message.id;
    const digest = fingerprint({
      sender: message.sender,
      subject: message.subject,
      text: message.text,
      parsed,
    });
    await this.store.db.transaction(async (client) => {
      const row = (
        await client.query<OutboxRow & { state: string }>(
          "SELECT * FROM public.mail_outbox WHERE mailbox=$1 AND business_policy=$2 AND (correlation_key=$3 OR (correlation_key IS NULL AND command_key=$3))",
          [this.store.id, policy.id, parsed.key],
        )
      ).rows[0];
      if (
        !row ||
        !row.wait_key ||
        row.policy_version !== policy.version ||
        row.recipient !== message.sender ||
        !["sending", "sent", "uncertain"].includes(row.state)
      )
        throw new Problem(409, "MAIL_RECEIPT_UNBOUND");
      const old = (
        await client.query<{ request_hash: string; request_id: string }>(
          "SELECT request_hash,request_id FROM public.mail_service_receipts WHERE mailbox=$1 AND event_key=$2",
          [this.store.id, eventKey],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== digest || old.request_id !== row.id)
          throw new Problem(409, "MAIL_RECEIPT_CONFLICT");
      } else {
        policy.receipt!.validate(parsed.response, this.input(row));
        const actor = await this.identity.current(
          this.store.settings.workspace,
          policy.receipt!.principal,
        );
        requireCapability(actor, policy.capability);
        await new SignalStore(this.store.db).receiveMailReceipt(
          client,
          actor,
          row.id,
          parsed.response,
          `mail-receipt:${row.id}`,
          policy.capability,
        );
        await client.query(
          "INSERT INTO public.mail_service_receipts(mailbox,event_key,request_id,request_hash) VALUES($1,$2,$3,$4)",
          [this.store.id, eventKey, row.id, digest],
        );
      }
      await client.query(
        "UPDATE public.mail_inbound SET state='processed',task_id=$3,error=NULL WHERE mailbox=$1 AND message_id=$2",
        [this.store.id, message.id, row.source_task],
      );
    });
    return true;
  }
  private policy(id: string) {
    const policy = this.policies.get(id);
    if (!policy) throw new Problem(409, "MAIL_POLICY_UNAVAILABLE");
    return policy;
  }
  private input(row: OutboxRow): BusinessMailInput {
    return {
      key: row.command_key!,
      correlationKey: row.correlation_key ?? undefined,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      replyTo: row.reply_to || undefined,
      purpose: row.purpose,
      waitKey: row.wait_key ?? undefined,
      metadata: row.metadata,
    };
  }
}
