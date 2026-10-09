/** Svix 验签使用原始字节；回调仅落库，绝不在请求中下载邮件或执行模型。 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import type { MailSettings } from "../../packages/mail/contracts.js";
export function verifyWebhook(
  raw: Uint8Array,
  headers: Record<string, unknown>,
  settings: MailSettings,
) {
  // 端口接受通用字节数组；仅在 Node 适配器内转换，保留视图的起止范围。
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const secret = settings.webhookSecret,
    token = settings.webhookToken;
  if (!secret || !token) throw new Problem(503, "MAIL_WEBHOOK_DISABLED");
  const hash = (s: string) => createHash("sha256").update(s).digest();
  if (
    typeof headers.authorization !== "string" ||
    !timingSafeEqual(hash(headers.authorization), hash(`Bearer ${token}`))
  )
    throw new Problem(401, "MAIL_WEBHOOK_AUTH");
  const id = headers["svix-id"],
    timestamp = headers["svix-timestamp"],
    signatures = headers["svix-signature"];
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 1000 ||
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    typeof signatures !== "string"
  )
    throw new Problem(401, "MAIL_WEBHOOK_SIGNATURE");
  const expected = createHmac(
    "sha256",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
  )
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest();
  if (
    !signatures.split(/\s+/).some((s) => {
      const [version, encoded] = s.split(",");
      const got = Buffer.from(encoded ?? "", "base64");
      return (
        version === "v1" &&
        got.length === expected.length &&
        timingSafeEqual(got, expected)
      );
    })
  )
    throw new Problem(401, "MAIL_WEBHOOK_SIGNATURE");
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString());
  } catch {
    throw new Problem(400, "INVALID_JSON");
  }
  const event = z
    .object({
      event_type: z.literal("message.received"),
      event_id: z.string().min(1).max(1000),
      message: z.object({
        inbox_id: z.string(),
        message_id: z.string().min(1).max(1000),
      }),
    })
    .parse(data);
  if (event.message.inbox_id !== settings.inbox)
    throw new Problem(403, "MAIL_WRONG_INBOX");
  return {
    id: event.event_id,
    messageId: event.message.message_id,
    digest: hash(bytes.toString("base64")).toString("hex"),
  };
}
