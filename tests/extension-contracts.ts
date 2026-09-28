/** 供连接器作者复用的边界断言；真实协议仍需对应供应商或受控协议服务测试。 */
import assert from "node:assert/strict";
import type { MailProvider } from "../packages/mail/contracts.js";
import type { ChannelProvider } from "../packages/channels/channel.js";
export async function verifyMailContract(
  provider: MailProvider,
  messageId: string,
) {
  const signal = AbortSignal.timeout(5000),
    page = await provider.list(null, signal);
  assert.ok(page.ids.includes(messageId));
  const message = await provider.read(messageId, signal);
  assert.equal(message.id, messageId);
  assert.equal(typeof message.authenticated, "boolean");
  assert.ok(message.sender && message.text);
  return message;
}
export async function verifyChannelContract(
  provider: ChannelProvider,
  raw: Buffer,
  headers: Record<string, unknown>,
) {
  const event = await provider.verify(raw, headers);
  assert.ok(event.eventId && event.subject && event.threadId);
  await assert.rejects(
    provider.verify(Buffer.concat([raw, Buffer.from(" ")]), headers),
  );
  return event;
}
