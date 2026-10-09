/** 上下文公共协议独立于快照存储，SDK 消费者无需数据库依赖。 */
import { z } from "zod";
import { DataSchema, type Data, type Principal } from "./index.js";
export const ContextDocument = z
  .object({
    id: z.string().min(1).max(200),
    text: z.string().max(24000),
    metadata: DataSchema.optional(),
    source: z
      .object({ uri: z.string().min(1), version: z.string().min(1) })
      .optional(),
    expiresAt: z.iso.datetime().optional(),
    purposes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ContextDocument = z.infer<typeof ContextDocument>;
export interface ContextProvider {
  id: string;
  version: string;
  /** 非秘密配置摘要，必须绑定领域/物理数据源及检索策略。 */
  identity: string;
  capability: string;
  load(
    query: Data,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<ContextDocument[]>;
  authorize(
    documents: ContextDocument[],
    principal: Principal,
    signal: AbortSignal,
  ): Promise<void>;
}
export type ContextReference = {
  provider: string;
  query: Data;
  purpose?: string;
};
