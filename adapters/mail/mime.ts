/** MIME 归一化不信任认证头；供应商或独立签名核验决定 authenticated。 */
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { Problem } from "../../packages/contracts/index.js";
import type { MailMessage } from "../../packages/mail/contracts.js";
export const MAX_MAIL_BYTES = 200_000;
export async function parseMime(source: Buffer) {
  if (source.length > MAX_MAIL_BYTES) throw new Problem(422, "MAIL_TOO_LARGE");
  return simpleParser(source, { skipHtmlToText: false, skipImageLinks: true });
}
export function messageId(value: string | undefined): string | undefined {
  return value && value.length <= 998 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value)
    ? value
    : undefined;
}
export function normalizeMime(
  mail: ParsedMail,
  id: string,
  authenticated: boolean,
  threadId?: string,
): MailMessage {
  const from = mail.from?.value;
  if (
    from?.length !== 1 ||
    !from[0]?.address ||
    mail.headerLines.filter((header) => header.key === "from").length !== 1
  )
    throw new Problem(403, "MAIL_SENDER_INVALID");
  validateHeaders(mail);
  const text = (mail.text ?? "").trim();
  if (!text || text.length > 40_000)
    throw new Problem(422, "MAIL_TEXT_INVALID");
  const reference = Array.isArray(mail.references)
    ? mail.references[0]
    : mail.references;
  return {
    id,
    threadId:
      threadId ??
      messageId(reference) ??
      messageId(mail.inReplyTo) ??
      messageId(mail.messageId) ??
      id,
    sender: z.email().parse(from[0].address).toLowerCase(),
    authenticated,
    automatic:
      (mail.headers.get("auto-submitted") ?? "no") !== "no" ||
      mail.headers.has("x-autoreply") ||
      mail.headers.has("x-autorespond"),
    subject: (mail.subject ?? "Mail task")
      .replace(/[\r\n]/g, " ")
      .slice(0, 200),
    text,
    inReplyTo: messageId(mail.inReplyTo),
    messageId: messageId(mail.messageId),
  };
}

function validateHeaders(mail: ParsedMail) {
  // 重复单值头会让 MIME 解析与 DKIM 选择不同的值，必须在执行前拒绝。
  for (const key of [
    "subject",
    "message-id",
    "in-reply-to",
    "references",
    "content-type",
    "content-transfer-encoding",
    "mime-version",
  ]) {
    if (mail.headerLines.filter((header) => header.key === key).length > 1)
      throw new Problem(422, "MAIL_HEADERS_AMBIGUOUS");
  }
}
