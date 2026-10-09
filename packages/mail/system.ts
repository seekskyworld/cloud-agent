/** 登录等非任务通知的可信宿主入口；复用 mail_outbox 和唯一发送器。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { Problem, type Data } from "../contracts/index.js";
import { bounded } from "../contracts/lifecycle.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { MailStore, OutboxRow } from "./store.js";
import type { MailDelivery } from "./contracts.js";
export interface SystemMailInput {
  key: string;
  recipient: string;
  subject: string;
  body: string;
  metadata: Data;
}
export interface SystemMailPolicy {
  id: string;
  version: string;
  prepare(
    input: SystemMailInput,
    signal: AbortSignal,
  ): Promise<{ subject: string; body: string }>;
}
export class SystemMail {
  constructor(
    private store: MailStore,
    private policies: readonly SystemMailPolicy[],
  ) {
    if (new Set(policies.map((p) => p.id)).size !== policies.length)
      throw new Error("MAIL_POLICY_DUPLICATE");
  }
  async enqueue(c: PoolClient, policyId: string, input: SystemMailInput) {
    await this.store.initialize();
    if (
      (
        await c.query<{ enabled: boolean }>(
          "SELECT public.runtime_maintenance_enabled() AS enabled",
        )
      ).rows[0]?.enabled
    )
      throw new Problem(503, "MAINTENANCE_ENABLED");
    const policy = this.policy(policyId);
    z.email().parse(input.recipient);
    z.string().min(1).max(200).parse(input.key);
    this.validate(input);
    const digest = fingerprint(input);
    const row = (
      await c.query<{ request_hash: string }>(
        `INSERT INTO public.mail_outbox(id,mailbox,system_policy,policy_version,command_key,request_hash,recipient,subject,body,reply_to,metadata,state,purpose)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,$11,'notification')
       ON CONFLICT(mailbox,system_policy,command_key) WHERE system_policy IS NOT NULL
       DO UPDATE SET command_key=EXCLUDED.command_key RETURNING request_hash`,
        [
          randomUUID(),
          this.store.id,
          policy.id,
          policy.version,
          input.key,
          digest,
          input.recipient,
          input.subject,
          input.body,
          JSON.stringify(input.metadata),
          this.store.settings.sendEnabled ? "pending" : "draft",
        ],
      )
    ).rows[0]!;
    if (row.request_hash !== digest)
      throw new Problem(409, "MAIL_COMMAND_CONFLICT");
  }
  async prepare(row: OutboxRow, signal: AbortSignal): Promise<MailDelivery> {
    const policy = this.policy(row.system_policy!);
    if (policy.version !== row.policy_version)
      throw new Problem(409, "MAIL_POLICY_CHANGED");
    const rendered = await bounded(
      5000,
      (deadline) =>
        policy.prepare(
          {
            key: row.command_key!,
            recipient: row.recipient,
            subject: row.subject,
            body: row.body,
            metadata: row.metadata,
          },
          deadline,
        ),
      signal,
    );
    this.validate(rendered);
    return {
      id: row.id,
      recipient: row.recipient,
      replyTo: "",
      purpose: "notification",
      ...rendered,
    };
  }
  private validate(value: { subject: string; body: string }) {
    if (
      !z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\r\n]+$/)
        .safeParse(value.subject).success ||
      !z.string().min(1).max(60000).safeParse(value.body).success
    )
      throw new Problem(422, "MAIL_CONTENT_INVALID");
  }
  private policy(id: string) {
    const p = this.policies.find((p) => p.id === id);
    if (!p) throw new Problem(409, "MAIL_POLICY_UNAVAILABLE");
    return p;
  }
}
