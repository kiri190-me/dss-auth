import "server-only";
import { constants } from "node:crypto";
import nodemailer from "nodemailer";
import { loadMailConfig, type MailConfig } from "./config";

/**
 * ============================================================================
 * 메일 한 통 보내기 — 무엇을 보낼지는 부르는 쪽이 정한다
 * ============================================================================
 * 이 모듈은 **주소와 글자를 받아 SMTP 로 넘기는 일만** 한다. 누구에게 · 무슨
 * 내용으로 · 보내도 되는 상황인지는 전부 부르는 쪽의 판단이다.
 *
 * 🔴 **던지지 않는다.** 결과를 값으로 돌려준다. 밤에 도는 작업이 사람마다 한
 * 통씩 보내는데, 한 사람에게 실패했다고 예외가 올라가면 **남은 사람의 메일이
 * 통째로 멎는다.** 부르는 쪽이 try 를 빠뜨려도 그 규율이 지켜져야 한다.
 *
 * 🔴 **오류 문구에 설정을 싣지 않는다.** nodemailer 의 오류는 서버 응답을 그대로
 * 담는데, 그 문구는 화면 · 작업 기록 · DB(`approval_mail_deliveries.error`) 로
 * 나간다. 길이를 자르고 config 는 절대 함께 담지 않는다.
 *
 * ── A/S 에서 옮겨 온 것과 다른 것 ────────────────────────────────────────
 * 모양은 `RF_Service_System/src/lib/server/mail/{transport,send}.ts` 를 따랐다.
 * 다른 점 둘:
 *  · **첨부도 HTML 도 없다.** 포털이 보내는 메일은 평문 한 벌뿐이고, 거기에는
 *    결재의 내용이 한 글자도 없다(approvals/mail-message.ts). 쓰지 않을 갈래를
 *    옮겨 오면 「내용을 싣지 않는다」는 약속이 코드 모양으로 흐려진다.
 *  · 받는 사람이 **언제나 한 명**이라 `bcc` 가 아니라 `to` 다. 전사 공지가
 *    아니라 「그 사람이 결재할 건」이라, 여러 사람을 한 통에 담을 일이 없다.
 * ============================================================================
 */

/**
 * 옛 TLS 서버에 붙기 위한 완화. `MAIL_SMTP_LEGACY_TLS=true` 일 때만 쓴다.
 *
 * 🔴 세 가지가 **모두** 있어야 카페24에 붙는다(A/S 2026-08-31 실측) — 하나만
 * 빠져도 못 붙는다:
 *   minVersion     TLS 1.0 까지 받아들인다
 *   ciphers        OpenSSL 3 의 보안 레벨이 옛 프로토콜을 아예 막는다.
 *                  SECLEVEL=0 으로 낮춰야 minVersion 이 뜻을 갖는다.
 *   secureOptions  이 서버는 안전한 재협상(RFC 5746)을 지원하지 않는다.
 *                  이것만 빠지면 "unsafe legacy renegotiation disabled" 로 막힌다.
 *
 * 🔴 `rejectUnauthorized` 는 건드리지 않는다 — 인증서 검증은 그대로다. 낮춘 것은
 * 프로토콜 버전이지 「서버가 진짜인지 확인하는 일」이 아니다.
 */
const LEGACY_TLS_OPTIONS = {
  minVersion: "TLSv1" as const,
  ciphers: "DEFAULT@SECLEVEL=0",
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
};

export type SendMailResult =
  | { ok: true; accepted: number }
  | { ok: false; reason: "NOT_CONFIGURED" | "SEND_FAILED"; message: string };

/** 오류 문구가 화면 · 작업 기록 · DB 에 실려도 부담 없는 길이로 자른다. */
const MAX_ERROR_LENGTH = 300;

function createTransport(config: MailConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // nodemailer 의 `secure` 는 「처음부터 TLS 로 붙는가」다(465). STARTTLS 는
    // 평문으로 붙었다가 승격하는 방식이라 여기서는 false 이고, 승격을 **강제**
    // 하는 것이 requireTLS 다 — 이걸 빼면 서버가 STARTTLS 를 제안하지 않을 때
    // 조용히 평문으로 로그인해 버린다.
    secure: config.secure === "ssl",
    requireTLS: config.secure === "starttls",
    // "none" 은 암호화를 아예 쓰지 않는 사내 릴레이용이다. 명시적으로 골라야만
    // 그렇게 되고, 그 외에는 nodemailer 가 STARTTLS 를 시도한다.
    ignoreTLS: config.secure === "none",
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    tls: config.legacyTls ? LEGACY_TLS_OPTIONS : undefined,
    // 서버가 답하지 않을 때 영원히 매달려 있지 않게 한다. 사람 수만큼 곱해지는
    // 시간이라 상한이 꼭 있어야 한다.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/**
 * 평문 메일 한 통. 받는 사람은 **한 명**이다.
 *
 * 🔵 연결을 한 통마다 새로 만들고 닫는다. 사람 수만큼 연결을 여닫는 셈이지만,
 * 하루 한 번 도는 작업이라 그 값이 눈에 띄지 않는다 — 대신 한 통이 실패해도
 * 다음 통이 멀쩡한 연결로 시작한다.
 */
export async function sendPlainMail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendMailResult> {
  if (input.to.trim() === "") {
    return { ok: false, reason: "SEND_FAILED", message: "받는 사람이 없습니다." };
  }

  const loaded = loadMailConfig();
  if (!loaded.ok) {
    return { ok: false, reason: "NOT_CONFIGURED", message: loaded.message };
  }

  const transport = createTransport(loaded.config);
  try {
    const info = await transport.sendMail({
      from: loaded.config.from,
      to: input.to,
      subject: input.subject,
      // 🔴 `html` 을 넣지 않는다(이 파일 머리말). 평문 한 벌이 전부다.
      text: input.text,
    });
    return { ok: true, accepted: info.accepted?.length ?? 1 };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "SEND_FAILED", message: raw.slice(0, MAX_ERROR_LENGTH) };
  } finally {
    // 열어 둔 연결을 반드시 닫는다 — 안 닫으면 스크립트가 끝나지 않는다.
    transport.close();
  }
}
