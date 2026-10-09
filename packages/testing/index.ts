/** 独立扩展的契约检查；供应商副作用只在调用方显式提供的隔离环境执行。 */
import assert from "node:assert/strict";
import {
  canReceive,
  type MailTransport,
  type MailProvider,
  type MailMessage,
  type MailDelivery,
} from "../mail/contracts.js";
export async function verifyMailContract(
  provider: MailTransport,
  messageId: string,
): Promise<MailMessage> {
  assert.ok(canReceive(provider), "MAIL_RECEIVE_UNSUPPORTED");
  const signal = AbortSignal.timeout(5000),
    page = await provider.list(null, signal);
  assert.ok(page.ids.includes(messageId));
  const message = await provider.read(messageId, signal);
  assert.equal(message.id, messageId);
  assert.equal(typeof message.authenticated, "boolean");
  assert.ok(message.sender && message.text);
  return message;
}
export async function verifyMailSendContract(
  provider: Pick<MailProvider, "send">,
  delivery: MailDelivery,
): Promise<string> {
  const id = await provider.send(delivery, AbortSignal.timeout(5000));
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
  return id;
}
