/** 身份管理命令的中立协议；角色不授予业务通配权限。 */
import { z } from "zod";
const IdentityId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9@._+-]*$/);
export const AccessChange = z
  .object({
    id: IdentityId,
    role: z.enum(["member", "admin"]),
    capabilities: z.array(z.string().min(1).max(120)).max(100),
    enabled: z.boolean(),
    expectedVersion: z.number().int().positive().nullable(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
