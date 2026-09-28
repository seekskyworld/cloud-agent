/** 领域端口由接入方显式装配；通用宿主不内置业务仓储。 */
import type { PortBinding } from "../packages/business/application.js";
export const businessPortIds: string[] = [];
export function createBusinessPorts(): Record<string, PortBinding> {
  return {};
}
