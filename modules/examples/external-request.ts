/** 中立组合示例，不注册到默认清单。领域端口通过业务包/宿主显式绑定。 */
import { z } from "zod";
import type {
  ExecutionContext,
  Json,
  Module,
  Principal,
  Step,
} from "cloud-agent/sdk";
const Input = z
  .object({
    reference: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();
const Receipt = z
  .object({
    accepted: z.boolean(),
    reference: z.string(),
    version: z.number().int(),
  })
  .strict();
export interface ExternalRequestPort {
  authorize(
    principal: Principal,
    steps: Step[],
    signal: AbortSignal,
  ): Promise<void>;
  /** 在 BusinessTransactions.run 内校验版本、更新领域数据并 enqueue；复用 context.idempotencyKey。 */
  enqueue(
    input: z.infer<typeof Input>,
    context: ExecutionContext,
  ): Promise<{ requestKey: string }>;
  /** 同一幂等键只应用一次；拒绝/超时不自动推断远端未执行。 */
  apply(
    input: z.infer<typeof Input>,
    receipt: z.infer<typeof Receipt>,
    context: ExecutionContext,
  ): Promise<Json>;
}
export function externalRequestModule(port: ExternalRequestPort): Module {
  return {
    id: "external-request",
    version: "1.0.0",
    title: "外部服务请求",
    description: "复用任务确认、事务发件与外部等待的组合示例",
    capability: "example:request",
    input: Input,
    example: { reference: "example-record", version: 1 },
    runtime: { model: false },
    validateContext: (steps, principal, signal) =>
      port.authorize(principal, steps, signal),
    authorizeRead: (_task, principal, signal, steps) =>
      port.authorize(principal, steps, signal),
    tools: [
      {
        name: "external.enqueue",
        version: "1.0.0",
        description: "确认后登记请求；入队成功不代表远端业务成功",
        input: Input,
        output: z.object({ requestKey: z.string() }),
        capability: "example:request",
        effect: "idempotent_write",
        approval: true,
        timeoutMs: 10000,
        async execute(input, context) {
          return {
            kind: "succeeded",
            output: await port.enqueue(Input.parse(input), context),
          };
        },
      },
      {
        name: "external.apply",
        version: "1.0.0",
        description: "依据已验证回执幂等更新领域状态",
        input: z.object({ request: Input, receipt: Receipt }).strict(),
        output: z.json(),
        capability: "example:request",
        effect: "idempotent_write",
        timeoutMs: 10000,
        async execute(input, context) {
          const value = z
            .object({ request: Input, receipt: Receipt })
            .parse(input);
          if (
            value.request.reference !== value.receipt.reference ||
            value.request.version !== value.receipt.version
          )
            return {
              kind: "rejected",
              code: "RECEIPT_MISMATCH",
              message: "回执与已确认请求不匹配",
            };
          return {
            kind: "succeeded",
            output: await port.apply(value.request, value.receipt, context),
          };
        },
      },
    ],
    next(input, steps) {
      const done = (key: string) =>
        steps.find((s) => s.key === key && s.status === "succeeded");
      if (!done("enqueue"))
        return {
          kind: "tool",
          key: "enqueue",
          name: "external.enqueue",
          input,
        };
      const receipt = done("receipt");
      if (!receipt)
        return {
          kind: "wait",
          key: "receipt",
          waitKind: "external",
          reason: "等待已认证的外部回执",
          schema: z.json().parse(z.toJSONSchema(Receipt)),
          expiresInMs: 86400000,
        };
      const result = done("apply");
      if (!result)
        return {
          kind: "tool",
          key: "apply",
          name: "external.apply",
          input: { request: input, receipt: receipt.output },
        };
      return { kind: "complete", result: result.output };
    },
  };
}
