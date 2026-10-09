import type { Buffer } from "node:buffer";
export interface ArtifactStore {
  id: string;
  /** 必须绑定物理位置；自定义实现变更位置时更换 identity。 */
  identity: string;
  put(key: string, data: Buffer, signal: AbortSignal): Promise<void>;
  get(key: string, signal: AbortSignal): Promise<Buffer>;
  remove(key: string, signal: AbortSignal): Promise<void>;
  close?: () => Promise<void>;
}
