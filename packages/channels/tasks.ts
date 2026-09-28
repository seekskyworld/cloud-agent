/** 渠道共用身份绑定、会话与等待操作；协议适配器只能提供已核验的外部身份。 */
import {
  Problem,
  requireCapability,
  type Principal,
  type Data,
} from "../contracts/index.js";
import type { IdentityService } from "../identity/service.js";
import type { TaskService } from "../runtime/service.js";
export class ChannelTasks {
  constructor(
    private identity: IdentityService,
    private tasks: TaskService,
  ) {}
  async actor(
    workspace: string,
    subject: string,
    bindings: Record<string, string>,
    capability: string,
    missing = "CHANNEL_IDENTITY_NOT_CONFIGURED",
  ) {
    const id = bindings[subject];
    if (!id) throw new Problem(403, missing);
    const principal = await this.identity.current(workspace, id);
    requireCapability(principal, capability);
    return principal;
  }
  async submit(input: {
    principal: Principal;
    key: string;
    namespace: string;
    thread: string;
    title: string;
    route: () => { moduleId: string; input: Data };
    reply?: { taskId: string; waitId?: string | null; response?: Data };
  }) {
    const { principal, key, reply } = input;
    if (reply?.waitId) {
      await this.tasks.respond(
        principal,
        reply.waitId,
        reply.response ?? {},
        key,
        reply.taskId,
      );
      return reply.taskId;
    }
    const conversation = reply
      ? (await this.tasks.get(principal, reply.taskId)).conversation_id
      : await this.tasks.conversationFor(
          principal,
          input.namespace,
          input.thread,
          input.title,
        );
    const action = input.route();
    return (
      await this.tasks.create(
        principal,
        action.moduleId,
        action.input,
        key,
        conversation,
      )
    ).id;
  }
}
