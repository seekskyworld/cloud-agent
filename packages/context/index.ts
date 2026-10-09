/** 可选上下文端口；供应器负责领域 ACL，核心负责隔离、快照和预算。 */
import { z } from "zod";
import {
  DataSchema,
  Problem,
  requireCapability,
  type Principal,
  type Task,
} from "../contracts/index.js";
import { abortable } from "../contracts/lifecycle.js";
import { fingerprint } from "../contracts/fingerprint.js";
import type { Database } from "../persistence/database.js";
import {
  ContextDocument,
  type ContextProvider,
  type ContextReference,
} from "../contracts/context.js";
export {
  ContextDocument,
  type ContextProvider,
  type ContextReference,
} from "../contracts/context.js";
interface Snapshot {
  provider_id: string;
  provider_hash: string;
  documents: ContextDocument[];
}
export class ContextManager {
  private providers = new Map<string, ContextProvider>();
  constructor(
    private db: Database,
    entries: ContextProvider[] = [],
  ) {
    for (const provider of entries) {
      if (this.providers.has(provider.id))
        throw new Error("CONTEXT_PROVIDER_DUPLICATE");
      this.providers.set(provider.id, provider);
    }
  }
  fingerprints() {
    return Object.fromEntries(
      [...this.providers].map(([id, p]) => [
        id,
        fingerprint({
          id,
          version: p.version,
          identity: p.identity,
          capability: p.capability,
        }),
      ]),
    );
  }
  private provider(id: string, principal: Principal) {
    const p = this.providers.get(id);
    if (!p) throw new Problem(422, "CONTEXT_PROVIDER_UNAVAILABLE");
    requireCapability(principal, p.capability);
    return p;
  }
  private async authorize(
    row: Snapshot,
    principal: Principal,
    signal: AbortSignal,
  ) {
    if (
      row.documents.some(
        (d) => d.expiresAt && Date.parse(d.expiresAt) <= Date.now(),
      )
    )
      throw new Problem(403, "CONTEXT_EXPIRED");
    const p = this.provider(row.provider_id, principal);
    if (row.provider_hash !== this.fingerprints()[p.id])
      throw new Problem(409, "CONTEXT_PROVIDER_CHANGED");
    await abortable(signal, () =>
      p.authorize(row.documents, principal, signal),
    );
  }
  async authorizeTask(task: Task, principal: Principal, signal: AbortSignal) {
    if (
      task.workspace_id !== principal.workspace_id ||
      task.principal_id !== principal.id
    )
      throw new Problem(404, "TASK_NOT_FOUND");
    const rows = (
      await this.db.pool.query<Snapshot>(
        "SELECT provider_id,provider_hash,documents FROM context_snapshots WHERE task_id=$1",
        [task.id],
      )
    ).rows;
    for (const row of rows) await this.authorize(row, principal, signal);
  }
  async load(
    task: Task,
    stepId: string,
    references: ContextReference[],
    allowed: string[],
    principal: Principal,
    signal: AbortSignal,
  ): Promise<ContextDocument[]> {
    if (references.length > 4)
      throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
    const documents: ContextDocument[] = [];
    for (const ref of references) {
      if (!allowed.includes(ref.provider))
        throw new Problem(403, "CONTEXT_DEPENDENCY_UNDECLARED");
      documents.push(
        ...(await this.snapshot(task, stepId, ref, principal, signal)),
      );
    }
    if (
      documents.length > 20 ||
      Buffer.byteLength(JSON.stringify(documents)) > 48000
    )
      throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
    return documents;
  }
  private async snapshot(
    task: Task,
    stepId: string,
    ref: ContextReference,
    principal: Principal,
    signal: AbortSignal,
  ) {
    if (
      task.workspace_id !== principal.workspace_id ||
      task.principal_id !== principal.id
    )
      throw new Problem(404, "TASK_NOT_FOUND");
    const p = this.provider(ref.provider, principal),
      hash = fingerprint(ref);
    let row = (
      await this.db.pool.query<Snapshot>(
        "SELECT provider_id,provider_hash,documents FROM context_snapshots WHERE step_id=$1 AND request_hash=$2",
        [stepId, hash],
      )
    ).rows[0];
    if (!row) {
      const parsed = z
        .array(ContextDocument)
        .max(20)
        .safeParse(
          await abortable(signal, () =>
            p.load(DataSchema.parse(ref.query), principal, signal),
          ),
        );
      if (!parsed.success) throw new Problem(422, "CONTEXT_DOCUMENT_INVALID");
      const docs = parsed.data;
      if (Buffer.byteLength(JSON.stringify(docs)) > 48000)
        throw new Problem(422, "CONTEXT_BUDGET_EXCEEDED");
      await abortable(signal, () => p.authorize(docs, principal, signal));
      // 租约检查和不可变快照写入原子提交，过期 Worker 无权污染新运行。
      await this.db.transaction(async (client) => {
        const valid = await client.query(
          "SELECT id FROM tasks WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
          [task.id, task.lease_token],
        );
        if (!valid.rowCount) throw new Problem(409, "LEASE_LOST");
        await client.query(
          "INSERT INTO context_snapshots(task_id,step_id,request_hash,provider_id,provider_hash,documents) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            task.id,
            stepId,
            hash,
            p.id,
            this.fingerprints()[p.id],
            JSON.stringify(docs),
          ],
        );
      });
      row = (
        await this.db.pool.query<Snapshot>(
          "SELECT provider_id,provider_hash,documents FROM context_snapshots WHERE step_id=$1 AND request_hash=$2",
          [stepId, hash],
        )
      ).rows[0]!;
    }
    await this.authorize(row, principal, signal);
    if (
      row.documents.some(
        (d) =>
          d.purposes && (!ref.purpose || !d.purposes.includes(ref.purpose)),
      )
    )
      throw new Problem(403, "CONTEXT_PURPOSE_FORBIDDEN");
    return row.documents;
  }
}
