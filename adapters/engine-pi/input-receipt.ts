import { createHash } from "node:crypto";
import type { Json, ModelRequest } from "../../packages/contracts/index.js";

const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

/** Inspect only image containers in the final HTTP body; never retain payload text or credentials. */
export function wireImages(
  value: unknown,
): { sha256: string; bytes: number; mediaType: string }[] {
  if (Array.isArray(value)) return value.flatMap(wireImages);
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (
    row.type === "base64" &&
    typeof row.data === "string" &&
    typeof row.media_type === "string"
  ) {
    const data = Buffer.from(row.data, "base64");
    return [
      { sha256: digest(data), bytes: data.length, mediaType: row.media_type },
    ];
  }
  if (
    (row.type === "image_url" || row.type === "input_image") &&
    row.image_url
  ) {
    const url =
      typeof row.image_url === "string"
        ? row.image_url
        : (row.image_url as { url?: string }).url;
    const match =
      typeof url === "string"
        ? /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(url)
        : null;
    if (match) {
      const data = Buffer.from(match[2]!, "base64");
      return [
        { sha256: digest(data), bytes: data.length, mediaType: match[1]! },
      ];
    }
  }
  return Object.values(row).flatMap(wireImages);
}

export function inputReceipt(
  request: ModelRequest,
  body: string,
  accepted: boolean,
): Json {
  const contextOmissions: Json[] = [];
  const declared: {
    sha256: string;
    reference: Json;
    timestampSeconds: number | null;
  }[] = [];
  for (const message of request.messages) {
    contextOmissions.push(...(message.contextOmissions ?? []));
    let reference: Json = null;
    for (const part of message.content ?? []) {
      if (part.type === "text") {
        const omissions = /^视觉工作集省略：(.*)$/.exec(part.text);
        if (omissions) {
          try {
            const values = JSON.parse(omissions[1]!);
            if (Array.isArray(values)) contextOmissions.push(...values);
          } catch {
            /* Invalid markers do not constitute evidence. */
          }
        }
        const marker = /^(?:图片证据|视频来源)：(.*)$/.exec(part.text);
        if (marker) {
          try {
            reference = JSON.parse(marker[1]!) as Json;
          } catch {
            reference = null;
          }
        }
      } else if (part.type === "image") {
        declared.push({
          sha256: digest(Buffer.from(part.data, "base64")),
          reference,
          timestampSeconds: null,
        });
      } else if (part.type === "video") {
        for (const frame of part.frames)
          declared.push({
            sha256: digest(Buffer.from(frame.data, "base64")),
            reference,
            timestampSeconds: frame.timestampSeconds,
          });
      }
    }
  }
  const sent = wireImages(JSON.parse(body));
  const hashes = new Set(sent.map((image) => image.sha256));
  return {
    schema: "model-input-receipt.v1",
    stage: "http_request_body",
    httpAccepted: accepted,
    payloadSha256: digest(body),
    images: sent.map((image) => ({
      ...image,
      references: declared.filter((v) => v.sha256 === image.sha256),
    })),
    declaredImageCount: declared.length,
    transmittedImageCount: sent.length,
    omitted: declared.filter((v) => !hashes.has(v.sha256)),
    contextOmissions,
    limitation:
      "Records the actual HTTP body and acceptance, not model attention, comprehension, full-video coverage or native hearing. Text-only audio explanations are not audio input.",
  };
}
