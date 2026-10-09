import { z } from "zod";
const reason = z.string().trim().min(1).max(1000);
export const CostResolution = z
  .object({
    invocation: z.string().min(1).max(200),
    expected: z.enum(["pending", "reported", "estimated"]),
    amount: z.number().nonnegative().finite(),
    reason,
    receipt: z.string().trim().min(1).max(500),
  })
  .strict();
export const JobChange = z
  .object({
    id: z.string().min(1).max(150),
    expectedHash: z.string(),
    enabled: z.boolean(),
    reason,
  })
  .strict();
