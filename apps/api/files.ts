/** 文件响应：支持 Range（视频拖动进度、断点续传）、inline/attachment 与 nosniff。 */
import type { FastifyReply, FastifyRequest } from "fastify";

export function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: { name: string; mediaType: string; data: Uint8Array },
  inline: boolean,
) {
  const data = Buffer.from(
    file.data.buffer,
    file.data.byteOffset,
    file.data.byteLength,
  );
  const bytes = data.length;
  const disposition = `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const base = reply
    .header("content-type", file.mediaType)
    .header("accept-ranges", "bytes")
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", disposition);
  const range = request.headers.range;
  if (typeof range !== "string")
    return base.header("content-length", bytes).send(data);
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2]))
    return base.code(416).header("content-range", `bytes */${bytes}`).send();
  // bytes=a-b、bytes=a-（到末尾）、bytes=-n（最后 n 字节）。
  const start = match[1]
    ? Number.parseInt(match[1], 10)
    : Math.max(0, bytes - Number.parseInt(match[2]!, 10));
  const end =
    match[1] && match[2]
      ? Math.min(Number.parseInt(match[2], 10), bytes - 1)
      : bytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= bytes
  )
    return base.code(416).header("content-range", `bytes */${bytes}`).send();
  return base
    .code(206)
    .header("content-range", `bytes ${start}-${end}/${bytes}`)
    .header("content-length", end - start + 1)
    .send(data.subarray(start, end + 1));
}
