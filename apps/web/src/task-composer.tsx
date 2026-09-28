/** 任务创建表单复用模块输入组件，关联会话仍由平台校验所有权。 */
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { Agent, Detail } from "./api.js";
import { ModuleInput } from "./module-views.js";
export function TaskComposer({
  agents,
  agentId,
  setAgentId,
  input,
  setInput,
  conversationId,
  setConversationId,
  detail,
  busy,
  submit,
}: {
  agents: Agent[];
  agentId: string;
  setAgentId: (id: string) => void;
  input: string;
  setInput: (value: string) => void;
  conversationId: string;
  setConversationId: (id: string) => void;
  detail: Detail | null;
  busy: boolean;
  submit: () => Promise<void>;
}) {
  const agent = agents.find((a) => a.id === agentId);
  return (
    <section className="panel">
      <p className="eyebrow">START SOMETHING</p>
      <h2>新建任务</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="agent">选择助手</label>
        <select
          id="agent"
          value={agentId}
          onChange={(event) => {
            setAgentId(event.target.value);
            setInput(
              JSON.stringify(
                agents.find((a) => a.id === event.target.value)?.example,
                null,
                2,
              ),
            );
          }}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
        <p className="muted">{agent?.description}</p>
        {agent && (
          <ModuleInput
            key={agent.id}
            moduleId={agent.id}
            schema={agent.inputSchema}
            value={input}
            onChange={setInput}
            label="任务内容"
          />
        )}
        <details>
          <summary>关联已有会话</summary>
          <input
            aria-label="会话 ID"
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
            placeholder="可选，填写当前用户的会话 ID"
          />
          {detail && (
            <button
              type="button"
              className="secondary"
              onClick={() => setConversationId(detail.task.conversation_id)}
            >
              使用当前任务会话
            </button>
          )}
        </details>
        <AstryxButton
          type="submit"
          variant="primary"
          label={busy ? "提交中…" : "创建任务 →"}
          isDisabled={busy || !agentId}
          isLoading={busy}
        />
      </form>
    </section>
  );
}
