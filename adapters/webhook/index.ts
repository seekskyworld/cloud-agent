/** 签名覆盖时间、事件 ID 与原始正文；目的地固定配置，不接受消息携带的回调地址。 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ChannelMessage,
  type ChannelProvider,
} from "../../packages/channels/channel.js";
import { Problem } from "../../packages/contracts/index.js";
import { DeliveryError } from "../../packages/channels/delivery.js";
import type { SecretProvider } from "../../packages/connections/index.js";
export class SignedWebhook implements ChannelProvider {
  constructor(
    private config: { credential: string; url?: string },
    private secrets: SecretProvider,
    private transport: typeof fetch = fetch,
  ) {}
  private async key() {
    const secret = await this.secrets(this.config.credential);
    if (typeof secret.signingKey !== "string" || secret.signingKey.length < 32)
      throw new Problem(503, "CHANNEL_CREDENTIAL_INVALID");
    return secret.signingKey;
  }
  async verify(raw: Buffer, headers: Record<string, unknown>) {
    const stamp = headers["x-channel-time"],
      signature = headers["x-channel-signature"];
    if (
      typeof stamp !== "string" ||
      !/^\d{10}$/.test(stamp) ||
      Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new Problem(401, "CHANNEL_SIGNATURE_INVALID");
    const expected = createHmac("sha256", await this.key())
      .update(`${stamp}.`)
      .update(raw)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new Problem(401, "CHANNEL_SIGNATURE_INVALID");
    try {
      return ChannelMessage.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new Problem(400, "CHANNEL_MESSAGE_INVALID");
    }
  }
  async send(id: string, payload: unknown, signal: AbortSignal) {
    if (!this.config.url)
      throw new DeliveryError("CHANNEL_SEND_DISABLED", true);
    const stamp = Math.floor(Date.now() / 1000).toString(),
      raw = JSON.stringify({ id, payload });
    const signature = createHmac("sha256", await this.key())
      .update(`${stamp}.${raw}`)
      .digest("hex");
    const response = await this.transport(this.config.url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        "x-channel-time": stamp,
        "x-channel-signature": signature,
        "idempotency-key": id,
      },
      body: raw,
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new DeliveryError(
        "CHANNEL_DELIVERY_REJECTED",
        response.status >= 400 && response.status < 500,
      );
  }
}
