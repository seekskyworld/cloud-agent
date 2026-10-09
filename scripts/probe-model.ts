/** 运维显式选择的合成协议探针；默认拒绝产生外部调用，不读取业务正文。 */
import { randomUUID } from "node:crypto";
import { PiEngine } from "../adapters/engine-pi/index.js";
import type { ModelCallContext } from "../packages/contracts/model-lifecycle.js";
if (!process.argv.includes("--allow-external-call"))
  throw new Error(
    "Pass --allow-external-call to send two synthetic model requests",
  );
const { loadConfig } = await import("../apps/config.js");
const config = loadConfig();
if (config.MODEL_MODE !== "pi" || !config.LLM_API_KEY)
  throw new Error("PI_CONFIGURATION_REQUIRED");
const engine = new PiEngine({
  baseUrl: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  model: config.LLM_MODEL,
  inputPrice: config.LLM_INPUT_PRICE,
  outputPrice: config.LLM_OUTPUT_PRICE,
  ...config.modelOptions,
});
const request = {
  instructions: "Return the word OK. Do not use tools.",
  messages: [{ role: "user" as const, text: "Synthetic protocol check." }],
  tools: [],
  maxOutputTokens: 32,
  reasoning: config.modelOptions?.reasoningLevels?.[0] ?? ("none" as const),
  timeoutMs: 10000,
};
function context(): ModelCallContext {
  return {
    principal: {
      id: "protocol-probe",
      workspace_id: "protocol-probe",
      capabilities: [],
      role: "member",
      enabled: true,
    },
    taskId: randomUUID(),
    invocation: {
      id: randomUUID(),
      operationKey: "synthetic-probe",
      deadlineAt: Date.now() + 10000,
    },
  };
}
const first = await engine.next(
  request,
  [],
  AbortSignal.timeout(10000),
  context(),
);
if (first.calls.length) throw new Error("MODEL_UNEXPECTED_TOOLS");
const controller = new AbortController(),
  ctx = context();
const timer = setTimeout(() => controller.abort(), 100);
let completed = false;
try {
  await engine.next(request, [], controller.signal, ctx);
  completed = true;
} catch {
  if (!controller.signal.aborted) throw new Error("MODEL_PROBE_REQUEST_FAILED");
} finally {
  clearTimeout(timer);
}
const receipt = engine.control
  ? await engine.control.cancel(ctx.invocation!, AbortSignal.timeout(3000))
  : { state: completed ? "completed" : "unknown" };
process.stdout.write(
  JSON.stringify({
    generation: "passed",
    cancelRequested: controller.signal.aborted,
    remoteState: receipt.state,
    providerBillingStopVerified: false,
  }) + "\n",
);
