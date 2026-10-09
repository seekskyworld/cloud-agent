/** 本地 TLS 邮箱替身实现测试所需 IMAP 命令；SMTP 使用真实协议服务，不接触外部账号。 */
import { createServer, type TLSSocket } from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { dkimSign } from "mailauth";
import type { StandardMailOptions } from "../../adapters/imap-smtp/index.js";
export async function mailServers(
  smtpTls: "implicit" | "starttls" = "implicit",
) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-mail-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "cert.pem")),
  };
  const state = {
    validity: 101,
    messages: new Map<number, Buffer>(),
    commands: [] as string[],
    sent: [] as Buffer[],
    reject: 0,
    auths: [] as string[],
    hold: undefined as (() => void) | undefined,
    onAcceptedData: undefined as (() => void) | undefined,
  };
  const sockets = new Set<TLSSocket>();
  const imap = createServer(tls, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] fixture\r\n");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      for (
        let end = buffer.indexOf("\r\n");
        end >= 0;
        end = buffer.indexOf("\r\n")
      ) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const split = line.indexOf(" "),
          tag = line.slice(0, split),
          command = line.slice(split + 1);
        state.commands.push(command.split(" ")[0]!);
        const ok = () => socket.write(`${tag} OK done\r\n`);
        if (command.startsWith("CAPABILITY")) {
          socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n");
          ok();
        } else if (
          command.startsWith("AUTHENTICATE") ||
          command.startsWith("LOGIN")
        )
          ok();
        else if (command.startsWith("EXAMINE")) {
          const next = Math.max(0, ...state.messages.keys()) + 1;
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${state.messages.size} EXISTS\r\n* OK [UIDVALIDITY ${state.validity}] epoch\r\n* OK [UIDNEXT ${next}] next\r\n${tag} OK [READ-ONLY] ready\r\n`,
          );
        } else if (command.startsWith("UID FETCH")) {
          fetchMessages(socket, command, state.messages);
          ok();
        } else if (command.startsWith("LOGOUT")) {
          socket.write("* BYE done\r\n");
          ok();
          socket.end();
        } else ok();
      }
    });
  });
  await new Promise<void>((resolve) => imap.listen(0, "127.0.0.1", resolve));
  const smtp = new SMTPServer({
    ...tls,
    secure: smtpTls === "implicit",
    logger: false,
    authMethods: ["PLAIN", "LOGIN", "XOAUTH2"],
    onAuth(auth, _session, callback) {
      state.auths.push(auth.accessToken ?? auth.password ?? "");
      callback(null, { user: auth.username });
    },
    onData(stream, _session, callback) {
      const parts: Buffer[] = [];
      stream.on("data", (chunk) => parts.push(Buffer.from(chunk)));
      stream.on("end", () => {
        state.sent.push(Buffer.concat(parts));
        if (state.onAcceptedData) {
          state.hold = () => callback();
          state.onAcceptedData();
          return;
        }
        if (state.reject) {
          callback(
            Object.assign(new Error("fixture rejection"), {
              responseCode: state.reject,
            }),
          );
          return;
        }
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const address = imap.address(),
    smtpAddress = smtp.server.address();
  if (
    !address ||
    typeof address === "string" ||
    !smtpAddress ||
    typeof smtpAddress === "string"
  )
    throw new Error("fixture ports");
  const options: StandardMailOptions = {
    address: "agent@example.test",
    user: "agent@example.test",
    credential: "standard",
    imap: {
      host: "127.0.0.1",
      port: address.port,
      tls: "implicit",
      folder: "INBOX",
      startFrom: "all",
    },
    smtp: { host: "127.0.0.1", port: smtpAddress.port, tls: smtpTls },
  };
  return {
    state,
    options,
    ca: tls.cert.toString(),
    async close() {
      state.hold?.();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => imap.close(() => resolve())),
        new Promise<void>((resolve) => smtp.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function fetchMessages(
  socket: TLSSocket,
  command: string,
  messages: Map<number, Buffer>,
) {
  const match = /UID FETCH (\d+)(?::(\d+|\*))?/.exec(command);
  if (!match) return;
  const low = Number(match[1]),
    high = match[2] === "*" ? Infinity : Number(match[2] ?? match[1]);
  let seq = 0;
  for (const [uid, source] of messages) {
    seq++;
    if (uid < low || uid > high) continue;
    if (command.includes("BODY.PEEK")) {
      socket.write(`* ${seq} FETCH (UID ${uid} BODY[] {${source.length}}\r\n`);
      socket.write(source);
      socket.write(")\r\n");
    } else
      socket.write(
        `* ${seq} FETCH (UID ${uid}${command.includes("RFC822.SIZE") ? ` RFC822.SIZE ${source.length}` : ""})\r\n`,
      );
  }
}
export function mailSigner() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const record = `v=DKIM1; k=rsa; p=${pair.publicKey.replace(/-----[^-]+-----|\s/g, "")}`;
  return {
    resolver: async (name: string) => {
      if (name !== "fixture._domainkey.example.test")
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return [[record]];
    },
    async sign(
      body = "hello",
      extra = "",
      headers = [
        "from",
        "to",
        "subject",
        "date",
        "message-id",
        "in-reply-to",
        "references",
        "content-type",
        "mime-version",
      ],
    ) {
      const raw = Buffer.from(
        `From: User <user@example.test>\r\nTo: agent@example.test\r\nSubject: fixture\r\nMessage-ID: <original@example.test>\r\nDate: ${new Date().toUTCString()}\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
      );
      const signature = {
        signingDomain: "example.test",
        selector: "fixture",
        privateKey: pair.privateKey,
      };
      // 库的声明要求顶层字段，运行时实际从 signatureData 读取配置、从冒号字符串读取 headerList。
      const result = await dkimSign(raw, {
        ...signature,
        signatureData: [signature],
        headerList: headers.join(":") as unknown as string[],
      });
      if (
        result.errors?.length ||
        !result.signatures.startsWith("DKIM-Signature:")
      )
        throw new Error("fixture signing failed");
      return Buffer.concat([Buffer.from(result.signatures), raw]);
    },
  };
}
