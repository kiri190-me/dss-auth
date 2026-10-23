/**
 * ============================================================================
 * 메일 서버(SMTP) 설정 — 환경에서 읽고, 모양만 본다
 * ============================================================================
 * 실제 연결도 발송도 여기서 하지 않는다(lib/mail/send.ts). 나눠 둔 까닭은 A/S 의
 * 같은 모듈과 같다 — 「설정이 맞는가」와 「무엇을 보내는가」는 다른 물음이고,
 * 나눠 두면 설정을 시험하는 코드가 발송 코드를 끌고 들어오지 않는다.
 *
 * 🔴 **칸 이름을 A/S(`RF_Service_System/src/lib/server/mail/config.ts`)와 똑같이
 * 맞췄다.** 두 시스템이 같은 메일 서버 한 대를 쓰고, NAS 에서는 설정이 시스템마다
 * 다른 파일(`nas/env/as.env` · `nas/env/auth.env`)에 들어간다. 이름이 다르면
 * 운영하는 사람이 같은 값을 두 가지 이름으로 외워야 하고, 한쪽만 고친 날 **그
 * 시스템의 메일만 조용히 멎는다.**
 *
 * ── 🔴 설정이 없으면 「꺼진 것」이다 ─────────────────────────────────────
 * 던지지 않고 **어느 칸이 비었는지 이름으로** 돌려준다. 이 저장소의 환경 읽기
 * (config/env.ts)는 값이 없으면 던지는 쪽인데 여기만 다른 까닭: 메일은 **로그인을
 * 좌우하는 기능이 아니다.** 메일 설정이 없다고 포털이 못 뜨면, 일곱 시스템의
 * 로그인이 메일 설정 한 줄에 묶인다. 그것이 훨씬 나쁘다.
 * 🔴 그렇다고 조용히 지나가지도 않는다 — 빠진 칸 이름을 관리자 화면과 작업
 * 기록이 그대로 보여 준다.
 *
 * ── 🔴 비밀번호는 밖으로 내지 않는다 ─────────────────────────────────────
 * 이 모듈이 비밀번호를 담아 돌려주는 곳은 `password` 한 자리뿐이고, 그 값을 쓰는
 * 곳은 연결을 만드는 자리 하나다. 로그 · 오류 문구 · 화면 어디에도 싣지 않는다.
 * 진단용 `describeMailConfig()` 는 비밀번호 자리에 **길이만** 적는다.
 * ============================================================================
 */

/** 587 은 STARTTLS, 465 는 처음부터 SSL, 사내 릴레이는 암호화 없이 25 를 쓰기도 한다. */
export const MAIL_SECURE_MODES = ["starttls", "ssl", "none"] as const;
export type MailSecureMode = (typeof MAIL_SECURE_MODES)[number];

export type MailConfig = {
  host: string;
  port: number;
  secure: MailSecureMode;
  /** 로그인 계정. 비우면 **인증 없이** 붙는다(사내 릴레이가 그렇다). */
  user: string | null;
  password: string | null;
  /** `"DSS 통합 로그인 <no-reply@example.com>"` 모양. 받는 사람 메일함에 이렇게 뜬다. */
  from: string;
  /**
   * 옛 TLS 를 쓰는 서버에 붙기 위한 완화. **기본은 꺼져 있다.**
   *
   * 🔴 카페24 메일 서버(smtp.cafe24.com)가 실제로 이렇다 — TLS 1.0/1.1 만 받고
   * 안전한 재협상(RFC 5746)을 지원하지 않는다. Node 의 OpenSSL 3 은 둘 다 기본
   * 으로 거부하므로 이걸 켜지 않으면 **아예 붙지 못한다**(A/S 2026-08-31 실측).
   *
   * 무엇을 푸는지 정확히 알고 켜야 한다:
   *   · 낮추는 것  — 받아들이는 TLS **버전**과 암호 모음
   *   · 그대로인 것 — **인증서 검증**(`rejectUnauthorized`). 끄지 않는다.
   */
  legacyTls: boolean;
};

export type LoadMailConfigResult =
  | { ok: true; config: MailConfig }
  | { ok: false; missing: string[]; message: string };

export const MAIL_ENV_KEYS = {
  host: "MAIL_SMTP_HOST",
  port: "MAIL_SMTP_PORT",
  secure: "MAIL_SMTP_SECURE",
  user: "MAIL_SMTP_USER",
  password: "MAIL_SMTP_PASSWORD",
  from: "MAIL_FROM",
  legacyTls: "MAIL_SMTP_LEGACY_TLS",
} as const;

/**
 * 🔵 환경을 **인자로 받는다** — A/S 쪽과 다른 한 가지다.
 *
 * A/S 는 `process.env` 를 직접 읽는데, 그러면 시험이 전역 환경을 고쳤다 되돌려야
 * 하고 그 되돌리기를 빠뜨리면 **옆 시험이 엉뚱한 설정으로 돈다**(이 저장소의
 * 시험은 한 프로세스에서 다 돈다). 기본값이 `process.env` 라 부르는 쪽은 그대로다.
 */
export type MailEnv = Record<string, string | undefined>;

function read(env: MailEnv, name: string): string | null {
  const trimmed = env[name]?.trim();
  return trimmed ? trimmed : null;
}

export function loadMailConfig(env: MailEnv = process.env): LoadMailConfigResult {
  const host = read(env, MAIL_ENV_KEYS.host);
  const portRaw = read(env, MAIL_ENV_KEYS.port);
  const from = read(env, MAIL_ENV_KEYS.from);

  /*
   * 🔵 빠진 칸을 모아 담는 일과 「셋 다 있다」를 못 박는 일을 **한 조건 안에서**
   * 한다. 따로 세면 TypeScript 가 아래에서 셋을 여전히 `string | null` 로 보고,
   * 그것을 `!` 로 눌러 두면 이 조건을 고치는 날 조용히 깨진다.
   */
  if (host === null || portRaw === null || from === null) {
    const missing: string[] = [];
    if (host === null) missing.push(MAIL_ENV_KEYS.host);
    if (portRaw === null) missing.push(MAIL_ENV_KEYS.port);
    if (from === null) missing.push(MAIL_ENV_KEYS.from);

    return {
      ok: false,
      missing,
      message: `메일 설정이 비어 있습니다: ${missing.join(", ")}. .env.local 을 확인하세요(.env.example 참고).`,
    };
  }

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      ok: false,
      missing: [MAIL_ENV_KEYS.port],
      // 포트 번호는 비밀이 아니므로 그대로 보여 준다 — 오타를 눈으로 찾게.
      message: `${MAIL_ENV_KEYS.port} 가 올바른 포트 번호가 아닙니다: "${portRaw}"`,
    };
  }

  /*
   * 보안 방식을 안 적었으면 포트에서 추론한다(465=SSL, 그 외=STARTTLS). 틀린
   * 기본값 하나로 조용히 평문 연결이 되는 것보다, 흔한 관례를 따르고 그 사실을
   * 적어 두는 편이 낫다 — A/S 와 같은 판단이다.
   */
  const secureRaw =
    read(env, MAIL_ENV_KEYS.secure)?.toLowerCase() ?? (port === 465 ? "ssl" : "starttls");
  if (!(MAIL_SECURE_MODES as readonly string[]).includes(secureRaw)) {
    return {
      ok: false,
      missing: [MAIL_ENV_KEYS.secure],
      message: `${MAIL_ENV_KEYS.secure} 는 ${MAIL_SECURE_MODES.join(" | ")} 중 하나여야 합니다. 지금 값: "${secureRaw}"`,
    };
  }

  const user = read(env, MAIL_ENV_KEYS.user);
  const password = read(env, MAIL_ENV_KEYS.password);

  // 계정만 있고 비밀번호가 없으면 인증이 반드시 실패한다. 붙어 보고 나서 알기보다
  // 여기서 잡는 편이 원인이 분명하다.
  if (user && !password) {
    return {
      ok: false,
      missing: [MAIL_ENV_KEYS.password],
      message: `${MAIL_ENV_KEYS.user} 를 적었으면 ${MAIL_ENV_KEYS.password} 도 있어야 합니다.`,
    };
  }

  return {
    ok: true,
    config: {
      host,
      port,
      secure: secureRaw as MailSecureMode,
      user,
      password,
      // 정확히 "true" 일 때만 켠다 — 오타가 조용히 완화로 이어지지 않게.
      legacyTls: read(env, MAIL_ENV_KEYS.legacyTls)?.toLowerCase() === "true",
      from,
    },
  };
}

/**
 * 진단용 한 줄. 🔴 **비밀번호는 길이만 적는다** — 화면 · 로그 어디에 실려도
 * 안전해야 한다.
 */
export function describeMailConfig(config: MailConfig): string {
  const auth = config.user
    ? `${config.user} / 비밀번호 ${config.password?.length ?? 0}자`
    : "인증 없음";
  const tls = config.legacyTls ? " · 옛 TLS 허용" : "";
  return `${config.host}:${config.port} (${config.secure}${tls}) · ${auth} · 발신 ${config.from}`;
}
