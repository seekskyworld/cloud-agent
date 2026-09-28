/** 注册回调前检查同 URL；结果不明不重试，避免创建重复推送或丢失一次性密钥。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MailProviderError } from "../../packages/mail/contracts.js";
const Hook = z.object({
  webhook_id: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  event_types: z.array(z.string()),
});
export async function registerWebhook(
  options: {
    baseUrl: string;
    apiKey: string;
    url: string;
    saved: Record<string, string>;
    save: (values: Record<string, string>) => Promise<void>;
  },
  transport: typeof fetch = fetch,
) {
  validateUrls(options.url, options.baseUrl);
  const request = async (query: string, body?: object): Promise<unknown> => {
    const response = await transport(
      `${options.baseUrl.replace(/\/$/, "")}/webhooks${query}`,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new MailProviderError(response.status);
    }
    return response.json();
  };
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const list = z
      .object({
        webhooks: z.array(Hook),
        next_page_token: z.string().nullish(),
      })
      .parse(
        await request(
          cursor ? `?page_token=${encodeURIComponent(cursor)}` : "",
        ),
      );
    const existing = list.webhooks.find((h) => h.url === options.url);
    if (existing) {
      if (
        existing.webhook_id !== options.saved.AGENTMAIL_WEBHOOK_ID ||
        !options.saved.AGENTMAIL_WEBHOOK_SECRET ||
        !options.saved.AGENTMAIL_WEBHOOK_TOKEN
      )
        throw new Error("MAIL_EXISTING_WEBHOOK_CREDENTIALS_MISSING");
      if (
        !existing.enabled ||
        !existing.event_types.includes("message.received")
      )
        throw new Error("MAIL_EXISTING_WEBHOOK_DISABLED");
      return;
    }
    if (!list.next_page_token) break;
    if (list.next_page_token === cursor || page === 99)
      throw new Error("MAIL_WEBHOOK_PAGINATION_INCOMPLETE");
    cursor = list.next_page_token;
  }
  if (options.saved.AGENTMAIL_WEBHOOK_ID)
    throw new Error("MAIL_SAVED_WEBHOOK_MISSING");
  const token =
    options.saved.AGENTMAIL_WEBHOOK_TOKEN || randomBytes(32).toString("hex");
  await options.save({ AGENTMAIL_WEBHOOK_TOKEN: token });
  const created = z
    .object({
      webhook_id: z.string().min(1),
      secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/),
    })
    .parse(
      await request("", {
        url: options.url,
        event_types: ["message.received"],
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  await options.save({
    AGENTMAIL_WEBHOOK_ID: created.webhook_id,
    AGENTMAIL_WEBHOOK_SECRET: created.secret,
    AGENTMAIL_WEBHOOK_URL: options.url,
  });
}

function validateUrls(callbackUrl: string, baseUrl: string) {
  const callback = new URL(callbackUrl),
    base = new URL(baseUrl);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    !/^\/hooks\/(?:agentmail|mail\/[A-Za-z0-9][A-Za-z0-9_@.+-]{0,319})$/.test(
      callback.pathname,
    )
  )
    throw new Error("MAIL_CALLBACK_URL_INVALID");
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("MAIL_BASE_URL_INVALID");
}
