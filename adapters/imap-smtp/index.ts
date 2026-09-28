/** 标准协议适配：只读 UID 同步与 TLS 发送，不把 IMAP 定位 ID 当回复 Message-ID。 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import { abortable } from "../../packages/contracts/lifecycle.js";
import {
  MailProviderError,
  type MailProvider,
  type MailDelivery,
  type MailCredentials,
} from "../../packages/mail/contracts.js";
import { MAX_MAIL_BYTES, parseMime, normalizeMime } from "../mail/mime.js";
import { authenticateMime, type DnsResolver } from "../mail/authentication.js";
export interface MailEndpoint {
  host: string;
  port: number;
  tls: "implicit" | "starttls";
}
export interface StandardMailOptions {
  address: string;
  user: string;
  credential: string;
  imap: MailEndpoint & { folder: string; startFrom: "new" | "all" };
  smtp: MailEndpoint;
}
const Cursor = z
  .object({
    validity: z.string().regex(/^\d{1,20}$/),
    uid: z.number().int().min(0).max(4294967295),
  })
  .strict();
/** 只映射明确协议响应，无法判断是否被接受的发送错误仍然属于未知。 */
function failure(error: unknown): Error {
  if (error instanceof Problem || error instanceof MailProviderError)
    return error;
  const fields = z
    .object({
      authenticationFailed: z.boolean().optional(),
      responseCode: z.number().optional(),
      code: z.string().optional(),
    })
    .safeParse(error);
  if (fields.success) {
    const value = fields.data;
    if (
      value.authenticationFailed ||
      value.code === "EAUTH" ||
      value.responseCode === 535
    )
      return new MailProviderError(401, "MAIL_AUTH_FAILED");
    if (
      value.responseCode &&
      value.responseCode >= 400 &&
      value.responseCode <= 599
    )
      return new MailProviderError(422, "MAIL_SMTP_REJECTED");
  }
  return new MailProviderError(503, "MAIL_CONNECTION_FAILED");
}
export class ImapSmtp implements MailProvider {
  constructor(
    private options: StandardMailOptions,
    private credentials: MailCredentials,
    private dependencies: { ca?: string; resolver?: DnsResolver } = {},
  ) {}
  private async authentication() {
    const secret = await this.credentials(this.options.credential);
    if (secret.kind === "api-key")
      throw new MailProviderError(401, "MAIL_CREDENTIAL_KIND");
    if (
      secret.kind === "oauth2" &&
      Date.parse(secret.expiresAt) <= Date.now() + 30_000
    )
      throw new MailProviderError(401, "MAIL_TOKEN_EXPIRED");
    return secret;
  }
  private async session<T>(
    signal: AbortSignal,
    action: (client: ImapFlow) => Promise<T>,
  ) {
    signal.throwIfAborted();
    const secret = await this.authentication(),
      endpoint = this.options.imap;
    const client = new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.tls === "implicit",
      doSTARTTLS: endpoint.tls === "starttls",
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        ca: this.dependencies.ca,
      },
      auth: {
        user: this.options.user,
        ...(secret.kind === "password"
          ? { pass: secret.password }
          : { accessToken: secret.accessToken }),
      },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      maxResponseSize: 1_000_000,
      maxLiteralSize: 250_000,
    });
    const abort = () => client.close();
    client.on("error", () => {}); // 请求 promise 映射为脱敏错误；防止连接关闭事件成为未捕获异常。
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await abortable(signal, async () => {
        await client.connect();
        await client.mailboxOpen(this.options.imap.folder, { readOnly: true });
        return action(client);
      });
    } catch (error) {
      throw failure(error);
    } finally {
      signal.removeEventListener("abort", abort);
      client.close();
    }
  }
  async list(cursor: string | null, signal: AbortSignal) {
    return this.session(signal, async (client) => {
      if (!client.mailbox)
        throw new MailProviderError(404, "MAIL_FOLDER_UNAVAILABLE");
      const validity = client.mailbox.uidValidity.toString(),
        last = client.mailbox.uidNext - 1;
      let previous: z.infer<typeof Cursor>;
      try {
        previous = cursor
          ? Cursor.parse(JSON.parse(cursor))
          : { validity, uid: this.options.imap.startFrom === "new" ? last : 0 };
      } catch {
        throw new MailProviderError(409, "MAIL_CURSOR_INVALID");
      }
      if (previous.validity !== validity)
        throw new MailProviderError(409, "MAIL_UIDVALIDITY_CHANGED");
      if (previous.uid >= last)
        return { ids: [], cursor: JSON.stringify(previous), hasMore: false };
      // 每次最多扫描 1000 个 UID，返回 50 个；空洞推进高水位，绝不用会随删除移动的序号。
      const high = Math.min(last, previous.uid + 1000);
      const found: number[] = [];
      for await (const message of client.fetch(
        `${previous.uid + 1}:${high}`,
        { uid: true },
        { uid: true },
      ))
        found.push(message.uid);
      const ids = found
        .filter((uid) => uid > previous.uid && uid <= high)
        .sort((a, b) => a - b)
        .slice(0, 50);
      const uid = ids.length === 50 ? ids.at(-1)! : high;
      return {
        ids: ids.map((id) => `${validity}:${id}`),
        cursor: JSON.stringify({ validity, uid }),
        hasMore: uid < last,
      };
    });
  }
  async read(id: string, signal: AbortSignal) {
    const match = /^(\d{1,20}):(\d{1,10})$/.exec(id);
    if (!match) throw new Problem(422, "MAIL_LOCATOR_INVALID");
    const source = await this.session(signal, async (client) => {
      if (!client.mailbox || client.mailbox.uidValidity.toString() !== match[1])
        throw new Problem(409, "MAIL_MESSAGE_EPOCH_CHANGED");
      const meta = await client.fetchOne(
        match[2]!,
        { size: true },
        { uid: true },
      );
      if (!meta) throw new MailProviderError(404, "MAIL_MESSAGE_GONE");
      if ((meta.size ?? 0) > MAX_MAIL_BYTES)
        throw new Problem(422, "MAIL_TOO_LARGE");
      const raw = await client.fetchOne(
        match[2]!,
        { source: { start: 0, maxLength: MAX_MAIL_BYTES + 1 } },
        { uid: true },
      );
      if (!raw || !raw.source)
        throw new MailProviderError(404, "MAIL_MESSAGE_GONE");
      return raw.source;
    });
    const message = normalizeMime(await parseMime(source), id, false);
    message.authenticated = await authenticateMime(
      source,
      message,
      signal,
      this.dependencies.resolver,
    );
    message.deduplicationId = message.messageId ?? id;
    return message;
  }
  async send(delivery: MailDelivery, signal: AbortSignal) {
    signal.throwIfAborted();
    const secret = await this.authentication(),
      endpoint = this.options.smtp;
    const transport = nodemailer.createTransport({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.tls === "implicit",
      requireTLS: endpoint.tls === "starttls",
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        ca: this.dependencies.ca,
      },
      auth:
        secret.kind === "password"
          ? { user: this.options.user, pass: secret.password }
          : {
              type: "OAuth2",
              user: this.options.user,
              accessToken: secret.accessToken,
            },
      logger: false,
      debug: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const abort = () => transport.close();
    signal.addEventListener("abort", abort, { once: true });
    const id = `<${delivery.id}@${this.options.address.split("@")[1]}>`;
    try {
      const result = await abortable(signal, () =>
        transport.sendMail({
          from: this.options.address,
          to: delivery.recipient,
          subject: delivery.subject,
          text: delivery.body,
          messageId: id,
          inReplyTo: delivery.replyTo,
          references: [delivery.replyTo],
          headers: { "Auto-Submitted": "auto-replied" },
        }),
      );
      if (result.rejected.length || !result.accepted.length)
        throw new MailProviderError(422, "MAIL_SMTP_REJECTED");
      return id;
    } catch (error) {
      throw failure(error);
    } finally {
      signal.removeEventListener("abort", abort);
      transport.close();
    }
  }
}
