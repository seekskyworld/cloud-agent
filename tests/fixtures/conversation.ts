/** 通用对话浏览器夹具：真实任务与校验流程，不访问外部模型。 */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  ModelEngine,
  ModelTurn,
  Module,
} from "../../packages/contracts/index.js";
import { pendingModel } from "./model-pending.js";

const Answer = z.object({ text: z.string() }).strict();
export const conversationModel: ModelEngine = {
  ...pendingModel,
  capabilities: { structuredOutput: "validated", maxOutputTokens: 2048 },
  async next(request, tools, signal, context) {
    if (request.instructions.startsWith("fixture:conversation\n")) {
      await delay(750, undefined, { signal });
      return {
        text: JSON.stringify({
          text:
            request.messages[0]?.text === "invalid" ? 42 : "你好，任务已完成。",
        }),
        calls: [],
        costUsd: 0,
        costEstimated: false,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    return pendingModel.next(request, tools, signal, context);
  },
};

export const conversationModule: Module = {
  id: "browser-conversation",
  version: "1",
  title: "对话回归示例",
  description: "browser fixture",
  capability: "report:run",
  runtime: { model: true },
  input: z.object({ text: z.string() }).strict(),
  example: { text: "你好" },
  tools: [],
  next(input, steps) {
    const done = steps.find(
      (s) => s.key === "answer" && s.status === "succeeded",
    );
    if (done)
      return {
        kind: "complete",
        result: Answer.parse((done.output as unknown as ModelTurn).data),
      };
    return {
      kind: "model",
      key: "answer",
      request: {
        instructions: "fixture:conversation",
        messages: [{ role: "user", text: String(input.text) }],
        tools: [],
        outputSchema: z.json().parse(z.toJSONSchema(Answer)),
      },
    };
  },
};
