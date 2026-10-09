/** 连接清单不含秘密；作用域与速率设置随可信部署配置发布。 */
import { z } from "zod";
const Schema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        endpoint: z.url().refine((value) => {
          const u = new URL(value);
          return (
            ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        }),
        credential: z.string().min(1),
        grants: z
          .array(
            z
              .object({
                workspace: z.string().min(1),
                principals: z.array(z.string().min(1)).min(1),
                capability: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
        ratePerMinute: z.number().int().min(1).max(100000).optional(),
      })
      .strict(),
  )
  .max(100);
export function loadConnections(value: string | undefined) {
  try {
    const entries = Schema.parse(JSON.parse(value || "[]"));
    if (new Set(entries.map((c) => c.id)).size !== entries.length)
      throw new Error("duplicate");
    return entries;
  } catch {
    throw new Error("CONNECTION_CONFIG_INVALID");
  }
}
