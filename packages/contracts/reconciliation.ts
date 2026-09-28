import { z } from "zod";
import { JsonSchema } from "./index.js";
export const Reconciliation = z
  .object({
    stepId: z.uuid(),
    expectedAttempts: z.number().int().min(1),
    decision: z.enum(["succeeded", "cancelled"]),
    output: JsonSchema.optional(),
    reason: z.string().trim().min(1).max(1000),
    receipt: z.string().trim().min(1).max(500),
  })
  .strict();
export type ReconciliationInput = z.infer<typeof Reconciliation>;
