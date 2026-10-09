/** 可信部署注册服务邮件协议；默认空，不从来信或环境 JSON 加载可执行代码。 */
import type { BusinessMailPolicy } from "../packages/mail/business-contracts.js";
export const businessMailPolicies: Record<
  string,
  readonly BusinessMailPolicy[]
> = {};
