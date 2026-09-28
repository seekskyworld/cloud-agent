/** 定时触发采用持久游标和唯一请求键，停机后合并错过的周期，避免任务风暴。 */
import { randomUUID } from "node:crypto";
import {
  requireCapability,
  type Data,
  type Principal,
} from "../contracts/index.js";
import type { Registry } from "../runtime/registry.js";
import { TaskStore } from "./tasks.js";
export class ScheduleStore {
  constructor(
    private tasks: TaskStore,
    private registry: Registry,
  ) {}
  async create(
    principal: Principal,
    moduleId: string,
    input: Data,
    seconds: number,
  ) {
    requireCapability(principal, "schedule:write");
    const module = this.registry.get(moduleId);
    requireCapability(principal, module.capability);
    const data = module.input.parse(input);
    return (
      await this.tasks.db.pool.query(
        "INSERT INTO schedules(id,workspace_id,principal_id,module_id,input,interval_seconds,next_at) VALUES($1,$2,$3,$4,$5,$6,now()+$6::integer*interval '1 second') RETURNING *",
        [
          randomUUID(),
          principal.workspace_id,
          principal.id,
          moduleId,
          JSON.stringify(data),
          seconds,
        ],
      )
    ).rows[0];
  }
  async list(principal: Principal) {
    requireCapability(principal, "schedule:write");
    return (
      await this.tasks.db.pool.query(
        "SELECT * FROM schedules WHERE workspace_id=$1 AND principal_id=$2 ORDER BY next_at",
        [principal.workspace_id, principal.id],
      )
    ).rows;
  }
  async remove(principal: Principal, id: string) {
    requireCapability(principal, "schedule:write");
    await this.tasks.db.pool.query(
      "UPDATE schedules SET enabled=false WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
      [id, principal.workspace_id, principal.id],
    );
  }
  async tick(): Promise<void> {
    await this.tasks.db.transaction(async (client) => {
      const due = (
        await client.query<{
          id: string;
          workspace_id: string;
          principal_id: string;
          module_id: string;
          input: Data;
          interval_seconds: number;
          next_at: Date;
        }>(
          "SELECT * FROM schedules WHERE enabled AND next_at<=now() ORDER BY next_at FOR UPDATE SKIP LOCKED LIMIT 10",
        )
      ).rows;
      for (const schedule of due) {
        const principal = (
          await client.query<Principal>(
            "SELECT id,workspace_id,enabled,capabilities,role FROM principals WHERE workspace_id=$1 AND id=$2",
            [schedule.workspace_id, schedule.principal_id],
          )
        ).rows[0];
        const module = this.registry
          .list()
          .filter((module) => module.id === schedule.module_id)
          .at(-1);
        if (
          !module ||
          !principal?.enabled ||
          !principal.capabilities.includes("schedule:write") ||
          !principal.capabilities.includes(module.capability)
        ) {
          await client.query("UPDATE schedules SET enabled=false WHERE id=$1", [
            schedule.id,
          ]);
          continue;
        }
        await this.tasks.createInTransaction(
          client,
          principal,
          schedule.module_id,
          schedule.input,
          `schedule:${schedule.id}:${schedule.next_at.toISOString()}`,
        );
        await client.query(
          "UPDATE schedules SET next_at=now()+interval_seconds*interval '1 second' WHERE id=$1",
          [schedule.id],
        );
      }
    });
  }
}
