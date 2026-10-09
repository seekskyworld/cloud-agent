/** IMAP 不提供可信 DMARC 元数据；独立验证完整 DKIM，拒绝伪造认证头及未签名回复关联。 */
import { parseMime } from "./mime.js";
import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth/lib/dkim/verify.js";
import { z } from "zod";
import {
  MailProviderError,
  type MailMessage,
} from "../../packages/mail/contracts.js";
import { abortable } from "../../packages/contracts/lifecycle.js";
const Result = z.object({
  results: z.array(
    z.object({
      status: z.object({
        result: z.string(),
        aligned: z.union([z.string(), z.boolean()]).optional(),
      }),
      signatureTimeValid: z.boolean().optional(),
      canonBodyLengthLimited: z.boolean().optional(),
      signingHeaders: z.object({ keys: z.string() }).optional(),
    }),
  ),
});
export type DnsResolver = (
  name: string,
  type: string,
) => Promise<string[][] | string[]>;
export async function authenticateMime(
  source: Buffer,
  message: MailMessage,
  signal: AbortSignal,
  resolver?: DnsResolver,
) {
  const dns = new Resolver({ timeout: 3000, tries: 1 });
  const lookup =
    resolver ??
    (async (name: string, type: string) => {
      signal.throwIfAborted();
      if (type !== "TXT") throw new Error("TXT only");
      return dns.resolveTxt(name);
    });
  const abort = () => dns.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = Result.parse(
      await abortable(signal, () =>
        dkimVerify(source, { resolver: lookup, minBitLength: 1024 }),
      ),
    );
    const mime = await parseMime(source);
    if (!message.messageId) return false;
    const required = [
      "from",
      "subject",
      "message-id",
      ...[
        "in-reply-to",
        "references",
        "content-type",
        "content-transfer-encoding",
        "mime-version",
      ].filter((key) => mime.headers.has(key)),
    ];
    if (
      result.results.some(
        (row) =>
          row.status.result === "pass" &&
          row.status.aligned &&
          row.signatureTimeValid === true &&
          row.canonBodyLengthLimited === false &&
          required.every((key) =>
            row.signingHeaders?.keys
              .split(":")
              .map((k) => k.trim().toLowerCase())
              .includes(key),
          ),
      )
    )
      return true;
    if (result.results.some((row) => row.status.result === "temperror"))
      throw new MailProviderError(503, "MAIL_DKIM_TEMPORARY");
    return false;
  } finally {
    signal.removeEventListener("abort", abort);
    dns.cancel();
  }
}
