/** 可信部署的隔离执行声明；revision 必须随执行代码更新。 */
import type { Data } from "./index.js";
export interface ProcessModule {
  entry: string;
  exportName: string;
  config?: Data;
  revision: string;
  memoryMb?: number;
  timeoutMs?: number;
}
