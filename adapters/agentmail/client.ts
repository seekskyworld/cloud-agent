/** AgentMail REST 与 MIME 防腐层；原件下载不携带 API key，不信任邮件中的认证头。 */
import { parseMime, normalizeMime } from "../mail/mime.js";
import { verifyWebhook } from "./webhook.js";
import type { MailSettings } from "../../packages/mail/contracts.js";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import {
  MailProviderError,
  type MailProvider,
  type MailDelivery,
} from "../../packages/mail/contracts.js";
const Id = z.string().min(1).max(1000);
const Message = z.object({
  message_id: Id,
  thread_id: Id.optional(),
  labels: z.array(z.string()),
  authentication_results: z.object({ dmarc: z.string().optional() }).optional(),
});
/** 同时限制声明长度和实际字节，服务端错误页不进入日志或模型。 */
async function bounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MailProviderError(response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Problem(502, "MAIL_EMPTY_BODY");
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Problem(422, "MAIL_TOO_LARGE");
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
export class AgentMail implements MailProvider {
  constructor(
    private inbox: string,
    private key: string,
    private base = "https://api.agentmail.to/v0",
    private downloadHosts = ["cdn.agentmail.to"],
    private transport: typeof fetch = fetch,
    private webhookSettings?: MailSettings,
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("AGENTMAIL_HTTPS_REQUIRED");
  }
  verifyWebhook(raw: Buffer, headers: Record<string, unknown>) {
    if (!this.webhookSettings) throw new Problem(503, "MAIL_WEBHOOK_DISABLED");
    return verifyWebhook(raw, headers, this.webhookSettings);
  }
  private async request(
    path: string,
    signal: AbortSignal,
    body?: object,
  ): Promise<unknown> {
    const response = await this.transport(
      `${this.base.replace(/\/$/, "")}/inboxes/${encodeURIComponent(this.inbox)}${path}`,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      },
    );
    return JSON.parse((await bounded(response, 1_000_000)).toString());
  }
  async list(cursor: string | null, signal: AbortSignal) {
    const query = new URLSearchParams({ limit: "50", labels: "received" });
    if (cursor) query.set("page_token", cursor);
    const page = z
      .object({
        messages: z.array(z.object({ message_id: Id })).max(50),
        next_page_token: Id.nullish(),
      })
      .parse(await this.request(`/messages?${query}`, signal));
    return {
      ids: page.messages.map((m) => m.message_id),
      cursor: page.next_page_token ?? null,
    };
  }
  async read(id: string, signal: AbortSignal) {
    const path = `/messages/${encodeURIComponent(id)}`;
    const meta = Message.parse(await this.request(path, signal));
    if (
      meta.message_id !== id ||
      !meta.labels.includes("received") ||
      meta.labels.some((l) =>
        ["sent", "spam", "trash", "blocked", "unauthenticated"].includes(l),
      )
    )
      throw new Problem(403, "MAIL_NOT_RECEIVED");
    const raw = z
      .object({ download_url: z.url(), size: z.number().nonnegative() })
      .parse(await this.request(`${path}/raw`, signal));
    const url = new URL(raw.download_url);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !this.downloadHosts.includes(url.hostname)
    )
      throw new Problem(403, "MAIL_DOWNLOAD_HOST");
    if (raw.size > 200_000) throw new Problem(422, "MAIL_TOO_LARGE");
    const response = await this.transport(url, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const mail = await parseMime(await bounded(response, 200_000));
    return normalizeMime(
      mail,
      id,
      meta.authentication_results?.dmarc === "pass",
      meta.thread_id ?? id,
    );
  }

  async send(delivery: MailDelivery, signal: AbortSignal) {
    const response = await this.request("/messages/send", signal, {
      to: [delivery.recipient],
      subject: delivery.subject,
      text: delivery.body,
      headers: {
        "Message-ID": `<${delivery.id}@cloud-agent.local>`,
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": delivery.replyTo,
        References: delivery.replyTo,
      },
    });
    return z.object({ message_id: Id }).parse(response).message_id;
  }
}
