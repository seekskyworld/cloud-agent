/** 业务提供只读判断，宿主控制截止时间及输出；不代表已执行真实业务交易。 */
import { bounded } from "../contracts/lifecycle.js";
import type { BusinessApplications } from "./application.js";
export interface BusinessCheck {
  id: string;
  phase: "ready" | "recovery";
  run(
    signal: AbortSignal,
  ): Promise<{ status: "passed" | "failed" | "unchecked"; code: string }>;
}
export class BusinessChecks {
  constructor(private applications: BusinessApplications) {}
  async run(phase: BusinessCheck["phase"]) {
    const checks: {
      packageId: string;
      id: string;
      status: "passed" | "failed" | "unchecked";
      code: string;
    }[] = [];
    for (const entry of this.applications.entries) {
      for (const check of (entry.instance.checks ?? []).filter(
        (c) => c.phase === phase,
      )) {
        try {
          const result = await bounded(5000, (signal) => check.run(signal));
          if (
            !["passed", "failed", "unchecked"].includes(result.status) ||
            !/^[A-Z][A-Z0-9_]{0,79}$/.test(result.code)
          )
            throw new Error("CHECK_INVALID");
          checks.push({ packageId: entry.id, id: check.id, ...result });
        } catch {
          checks.push({
            packageId: entry.id,
            id: check.id,
            status: "failed",
            code: "BUSINESS_CHECK_FAILED",
          });
        }
      }
    }
    return {
      phase,
      configured: checks.length,
      ok: checks.every((c) => c.status === "passed"),
      checks,
    };
  }
}
