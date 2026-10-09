import { z } from "zod";
import type { Buffer } from "node:buffer";
import { DataSchema } from "../contracts/index.js";
export const ChannelMessage = z
  .object({
    eventId: z.string().min(1).max(200),
    subject: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    input: DataSchema,
    replyTo: z.uuid().optional(),
    response: DataSchema.optional(),
  })
  .strict();
export type ChannelMessage = z.infer<typeof ChannelMessage>;
export interface ChannelProvider {
  verify(
    raw: Buffer,
    headers: Record<string, unknown>,
  ): Promise<ChannelMessage>;
  send(id: string, payload: unknown, signal: AbortSignal): Promise<void>;
  close?: () => Promise<void>;
}
export interface ChannelSettings {
  id: string;
  workspace: string;
  bindings: Record<string, string>;
  moduleId: string;
  sendEnabled: boolean;
  identity: unknown;
  capability?: string;
}
