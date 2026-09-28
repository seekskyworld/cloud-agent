/** 任务通知与业务消息共用一次投递；网络状态未知时绝不退回 pending。 */
import { deliveryFailure } from "../channels/delivery.js";
import { Problem } from "../contracts/index.js";
import {
  MailProviderError,
  type MailDelivery,
  type MailProvider,
} from "./contracts.js";
import type { MailStore, OutboxRow } from "./store.js";
export async function sendPending(
  store: MailStore,
  provider: MailProvider,
  signal: AbortSignal,
  prepare: (row: OutboxRow) => Promise<MailDelivery>,
) {
  if (!store.settings.sendEnabled) return;
  const row = await store.nextPending();
  if (!row) return;
  let delivery: MailDelivery;
  try {
    delivery = await prepare(row);
    signal.throwIfAborted();
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    await store.cancelOutbox(row.id, error.code);
    return;
  }
  if (!(await store.claimOutbox(row.id))) return;
  try {
    const providerId = await provider.send(delivery, signal);
    await store.sentOutbox(row.id, providerId);
  } catch (error) {
    const failure = deliveryFailure(error);
    await store.failOutbox(
      row.id,
      failure.state,
      error instanceof MailProviderError ? error.message : "MAIL_SEND_UNKNOWN",
    );
    if (error instanceof MailProviderError && [401, 403].includes(error.status))
      await store.block(error.message);
  }
}
