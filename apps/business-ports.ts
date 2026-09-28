/** 接入方唯一的领域端口工厂；业务模块仍只获取自己声明的类型化端口。 */
import type { PortBinding } from "../packages/business/application.js";
import type { Database } from "../packages/persistence/database.js";
import type { BusinessTransactions } from "../packages/persistence/business-transactions.js";
import type { IdentityService } from "../packages/identity/service.js";
import type { TaskService } from "../packages/runtime/service.js";
import type { MailChannel } from "../packages/mail/channel.js";
import type { Resources } from "../packages/extensions/registry.js";
import type { Config } from "./config.js";
export interface BusinessPortContext {
  config: Config;
  db: Database;
  identity: IdentityService;
  tasks: TaskService;
  transactions: BusinessTransactions;
  mails: readonly MailChannel[];
  resources: Resources;
}
export const businessPortIds: string[] = [];
export function createBusinessPorts(
  _context: BusinessPortContext,
): Record<string, PortBinding> {
  return {};
}
