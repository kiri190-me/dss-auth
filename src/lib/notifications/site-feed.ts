import type { RateLimitDecision } from "@/lib/http/rate-limit";
import type { PortalNotificationFeed } from "./merge";

/**
 * ============================================================================
 * 각 사이트의 **서버**가 포털에 묻는 통로 — 판정 전부
 * ============================================================================
 * 지금까지 뚫린 길은 전부 한 방향이었다:
 *
 *   포털 ──(포털이 서명한 토큰)──▶ 각 시스템        조각 2·3
 *
 * 이 파일은 **반대 방향**이다:
 *
 *   각 사이트의 서버 ──(자기 client_secret)──▶ 포털
 *
 * 🔴 방향이 반대라 인증도 반대다. `/api/notifications` 는 **세션 쿠키**로
 * 답하는데, 그 쿠키는 브라우저가 포털 도메인으로 올 때만 있다. 다른 사이트의
 * 서버에는 쿠키가 없다 — 그래서 문을 하나 더 낸다.
 *
 * ── 왜 라우트가 아니라 여기인가 ────────────────────────────────────────────
 * 이 통로의 값어치는 **거절이 제대로 되는가** 하나에 달려 있다. 라우트 안에
 * 두면 DB 와 서명 키가 붙어 있어 시험이 그 거절들을 돌려 볼 수 없다.
 * gather.ts 가 fetch 를 인자로 받는 것과 같은 이유로, 여기서는 DB 조회 넷을
 * 전부 인자로 받는다. 라우트는 그것을 진짜 함수로 채우는 열 줄짜리 껍데기다.
 *
 * ── ⚠️ 이 통로로 사이트는 사람을 사칭할 수 있다 ────────────────────────────
 * 사이트가 `sub` 에 아무 사람이나 적어 보낼 수 있다. 그것을 막을 방법은 없다 —
 * 사이트의 서버가 스스로 「지금 이 사람의 화면을 그리는 중」이라고 말하는 것이
 * 이 통로의 전부이기 때문이다. 받아들이는 까닭은 **그 사이트가 이미 그 사람들의
 * 업무 자료를 갖고 있기 때문**이다. A/S 는 그 사람의 수리 건을, PO 는 그 사람의
 * 발주를 이미 다 본다. 여기서 더 새는 것은 「그 사람이 **다른** 시스템에서 밀린
 * 일이 몇 건인가」이고, 그것이 위의 자료보다 민감하지 않다.
 *
 * 🔴 그래서 아래 둘이 **유일한 방어선**이고, 하나라도 빠지면 이 문은
 * 「아무 사이트나 아무 사람의 알림을 보는 문」이 된다:
 *
 *   1. 그 사람이 **그 사이트에 들어갈 수 있는 사람인가**(hasAccess).
 *      들어갈 수 없는 시스템이 그 사람의 알림을 보면 안 된다 — 그건 곧 그
 *      시스템에 「이 사람이 존재하고 이만큼 밀린 일이 있다」를 알리는 일이다.
 *      판정은 포털에 이미 있는 것을 그대로 쓴다(hasClientAccess). 새로 만들면
 *      앱 런처·백채널 로그아웃과 두 벌이 되고, 두 벌이 되는 순간 어긋난다.
 *   2. 그 사람이 **지금 쓸 수 있는 상태인가**(status = ACTIVE). 정지·삭제된
 *      계정의 알림은 어디에도 나가지 않는다.
 * ============================================================================
 */

/**
 * 받은 `sub` 의 길이 상한.
 *
 * 포털의 users.id 는 UUID(36자)다. 넉넉히 두되 상한은 둔다 — 없으면 수 MB 짜리
 * 문자열로 DB 조회를 돌리게 만들 수 있다.
 */
export const MAX_SUBJECT_LENGTH = 100;

/**
 * 🔴 쿼리에 실려 오면 **거절할** 이름들.
 *
 * 비밀값을 쿼리 문자열로 받지 않는 것만으로는 부족하다. 사이트가 실수로
 * `?client_secret=…` 를 붙여 보내면 그 값은 이미 접근 로그·프록시 로그에
 * 남았고, 우리가 조용히 무시하면 **아무도 모른 채로** 시크릿이 로그에 쌓인다.
 * 400 으로 되돌려 주면 붙이는 쪽이 첫 시도에서 알아차린다(그리고 그 시크릿은
 * 이미 샜으므로 다시 발급해야 한다고 말해 준다).
 */
const CREDENTIAL_QUERY_KEYS = ["client_secret", "secret", "client_assertion", "authorization"];

/** 자격증명을 받는 곳은 `Authorization: Basic` 하나뿐이다. */
export type SiteCredentials = { clientId: string; clientSecret: string };

/**
 * `Authorization: Basic base64(client_id:client_secret)` 를 읽는다.
 *
 * 토큰 엔드포인트(api/oidc/token/route.ts)와 **같은 읽기**다 — OAuth 2 의
 * client 인증 방식 그대로이고, 붙이는 쪽이 이미 그 방식으로 포털에 토큰을
 * 받으러 오고 있다. 새 방식을 만들면 사이트마다 코드가 한 벌 더 생긴다.
 *
 * RFC 6749 §2.3.1 대로 각 조각은 form-urlencode 된 상태라 디코드한다.
 *
 * 🔴 **본문 필드(client_id·client_secret)로는 받지 않는다.** 토큰 엔드포인트는
 * 둘 다 받지만(discovery 에 그렇게 선언했다), 이 통로는 새로 여는 문이라
 * 받는 길을 하나로 좁힌다. 길이 둘이면 둘 다 지켜야 한다.
 */
export function readBasicCredentials(header: string | null): SiteCredentials | null {
  if (!header?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  try {
    const clientId = decodeURIComponent(decoded.slice(0, separator));
    const clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

/** 🔴 비밀값이 주소에 실려 왔는가. 실려 왔으면 그 요청은 통과시키지 않는다. */
export function hasCredentialInQuery(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const key of CREDENTIAL_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) return true;
  }
  return false;
}

/**
 * 캐시 열쇠.
 *
 * 🔴 **사람이 들어간다.** 안 넣으면 먼저 부른 사람의 알림이 다음 사람에게
 * 그대로 간다(cache.ts 의 그 줄과 같은 위험이다).
 *
 * 🔴 **부른 사이트도 들어간다.** 답이 사이트마다 다르기 때문이다 — 아래
 * `exceptClientId` 대로 **부른 사이트 자신의 알림은 빼고** 답한다. 열쇠에
 * 사이트가 없으면 A/S 가 받아 간 답(= A/S 것이 빠진 답)이 PO 에게 그대로
 * 나가고, PO 의 종에서 A/S 알림이 사라진다.
 *
 * client_id 를 encodeURIComponent 로 감싸 두는 것은 두 조각의 경계(`:`)가
 * 값 안에 들어가 열쇠가 겹치는 일을 없애기 위해서다.
 */
export function siteFeedCacheKey(clientId: string, userId: string): string {
  return `${encodeURIComponent(clientId)}:${userId}`;
}

export type SiteFeedDeps<C extends { clientId: string }> = {
  /** 등록돼 있고 살아 있는 클라이언트만 돌려준다(없으면 null). */
  findActiveClient(clientId: string): Promise<C | null>;
  /** 저장된 해시와 대조한다. 타이밍에 기대지 않는 비교여야 한다. */
  verifySecret(client: C, presented: string): boolean;
  /** 포털의 그 사람. 없으면 null. */
  findUser(userId: string): Promise<{ status: string } | null>;
  /** 🔴 그 사람이 이 시스템에 들어갈 수 있는가. 앱 런처와 같은 판정이어야 한다. */
  hasAccess(userId: string, client: C): Promise<boolean>;
  /** 합쳐진 알림. `exceptClientId` 시스템에는 **묻지 않는다.** */
  feedFor(params: { userId: string; exceptClientId: string }): Promise<PortalNotificationFeed>;
  /**
   * 인증에 **실패한** 요청만 센다. 통과한 요청은 여기 오지 않는다.
   *
   * 🔴 정상 요청을 세지 않는 것이 중요하다. 이 통로는 각 사이트가 **화면을 그릴
   * 때마다** 부르는 곳이라, 정상 요청에 한도를 걸면 사람이 몰리는 아침에 종이
   * 통째로 꺼진다. 막으려는 것은 시크릿을 두드려 보는 반복뿐이다.
   */
  countAuthFailure?(): RateLimitDecision;
};

export type SiteFeedResponse = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** 🔴 서버 로그에만 남길 진짜 까닭. 응답 본문에는 싣지 않는다. */
  logReason?: string;
};

/**
 * 🔴 이 응답은 사람마다 다르고 30초면 뜻이 달라진다. 어디에도 남으면 안 된다.
 * 성공이든 거절이든 전부 붙인다.
 */
const NO_STORE: Record<string, string> = { "cache-control": "no-store", pragma: "no-cache" };

function reject(
  status: number,
  error: string,
  description: string,
  logReason: string,
  extraHeaders: Record<string, string> = {}
): SiteFeedResponse {
  return {
    status,
    body: { error, error_description: description },
    headers: { ...NO_STORE, ...extraHeaders },
    logReason,
  };
}

/**
 * 인증 실패의 응답은 **한 가지**다.
 *
 * 없는 client_id 와 시크릿이 틀린 client_id 를 구분해 주지 않는다 — 구분해 주면
 * 등록된 시스템 목록을 알아내는 조회 도구가 된다(토큰 엔드포인트와 같은 판단).
 * 401 에는 규격상 WWW-Authenticate 가 있어야 한다.
 */
function unauthorized(logReason: string): SiteFeedResponse {
  return reject(
    401,
    "invalid_client",
    "클라이언트 인증에 실패했습니다.",
    logReason,
    { "www-authenticate": 'Basic realm="dss-auth"' }
  );
}

/**
 * 🔴 「이 사람의 알림을 줄 수 없다」의 응답도 **한 가지**다.
 *
 * 없는 사람 · 정지된 사람 · 이 시스템에 들어갈 수 없는 사람을 구분해 주면,
 * 사이트 하나가 포털 사용자 목록과 각자의 접근 권한을 **묻는 것만으로** 알아낼
 * 수 있게 된다. 셋 다 같은 얼굴로 돌려주고, 구분은 서버 로그에만 남긴다.
 */
function forbidden(logReason: string): SiteFeedResponse {
  return reject(
    403,
    "forbidden",
    "이 사람의 알림을 내줄 수 없습니다.",
    logReason
  );
}

/**
 * 한 번의 요청을 끝까지 판정한다. 🔴 **던지지 않는다** — 던지면 사이트의
 * layout 이 500 을 받고, 그 사이트의 화면이 통째로 안 뜬다.
 *
 * 순서에 뜻이 있다:
 *   ① 주소에 비밀값이 실려 있는가 (DB 를 건드리기 전에 본다)
 *   ② 자격증명이 읽히는가         (DB 를 건드리기 전에 본다)
 *   ③ 본문에 누구인지 적혀 있는가 (DB 를 건드리기 전에 본다)
 *   ④ 그 시스템이 맞는가          ← 여기서부터 DB
 *   ⑤ 그 사람이 쓸 수 있는가
 *   ⑥ 🔴 그 시스템이 그 사람을 볼 수 있는가
 */
export async function handleSiteFeedRequest<C extends { clientId: string }>(
  request: Request,
  deps: SiteFeedDeps<C>
): Promise<SiteFeedResponse> {
  // ① 🔴 비밀값은 주소에 실리지 않는다.
  if (hasCredentialInQuery(request.url)) {
    return reject(
      400,
      "invalid_request",
      "자격증명은 Authorization 머리말로만 받습니다. 주소에 실린 값은 접근 로그에 남으므로 이 시크릿은 다시 발급하세요.",
      "credential_in_query"
    );
  }

  // ② 자격증명. 여기까지는 DB 를 한 번도 건드리지 않는다 — 머리말 없이
  //    두드리는 요청은 조회 한 번 값도 쓰지 않고 돌아간다.
  const credentials = readBasicCredentials(request.headers.get("authorization"));
  if (!credentials) {
    return withFailureLimit(deps, unauthorized("no_basic_credentials"));
  }

  // ③ 누구의 알림인가. 🔴 본문으로만 받는다(위 ①의 이유와 같다 — 사람의
  //    식별자도 접근 로그에 줄줄이 남을 값이 아니다).
  let body: string;
  try {
    body = await request.text();
  } catch {
    return reject(400, "invalid_request", "요청 본문을 읽을 수 없습니다.", "unreadable_body");
  }

  const subject = new URLSearchParams(body).get("sub")?.trim() ?? "";
  if (!subject) {
    return reject(400, "invalid_request", "sub 가 필요합니다.", "no_subject");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return reject(400, "invalid_request", "sub 가 너무 깁니다.", "subject_too_long");
  }

  // ④ 부르는 쪽이 등록된 시스템인가.
  const client = await deps.findActiveClient(credentials.clientId);
  if (!client || !deps.verifySecret(client, credentials.clientSecret)) {
    // 로그에 적는 client_id 는 **DB 에서 온 값**뿐이다(시크릿이 틀린 경우).
    // 없는 client_id 는 부르는 쪽이 지은 문자열이라 그대로 로그에 넣지
    // 않는다 — 줄바꿈을 섞어 로그를 어지럽히는 흔한 수법을 막는다.
    return withFailureLimit(deps, unauthorized(client ? `bad_secret:${client.clientId}` : "unknown_client"));
  }

  // ⑤ 그 사람이 지금 쓸 수 있는 계정인가.
  const user = await deps.findUser(subject);
  if (!user) return forbidden("unknown_subject");
  if (user.status !== "ACTIVE") return forbidden(`subject_status=${user.status}`);

  // ⑥ 🔴 그 시스템이 그 사람을 볼 수 있는가. 이 줄이 이 파일의 이유다.
  if (!(await deps.hasAccess(subject, client))) {
    return forbidden("no_client_access");
  }

  const feed = await deps.feedFor({ userId: subject, exceptClientId: client.clientId });
  return { status: 200, body: feed, headers: NO_STORE };
}

/**
 * 인증 실패를 센다. 한도를 넘었으면 401 대신 429 로 바꾼다.
 *
 * 🔴 **성공한 요청은 세지 않는다.** 이 함수는 거절이 이미 정해진 뒤에만 불린다
 * — 그래서 이 한도는 정상 트래픽을 절대 막지 못한다. 시크릿이 틀린 사이트에는
 * 429 가 가는데, 그 편이 401 을 무한히 돌려주는 것보다 낫다(설명에 「시크릿을
 * 확인하라」를 적어 둔다 — 아니면 「갑자기 429 가 온다」로만 보인다).
 */
function withFailureLimit<C extends { clientId: string }>(
  deps: SiteFeedDeps<C>,
  rejection: SiteFeedResponse
): SiteFeedResponse {
  const decision = deps.countAuthFailure?.();
  if (!decision || decision.allowed) return rejection;

  const limited = reject(
    429,
    "temporarily_unavailable",
    "인증 실패가 너무 잦습니다. client_id 와 client_secret 이 맞는지 확인하세요.",
    `${rejection.logReason ?? "auth_failed"}+rate_limited`,
    { "retry-after": String(decision.retryAfterSeconds) }
  );

  // 🔴 한도에 걸린 뒤로는 **첫 한 줄만** 남긴다. 거절마다 로그를 쓰면 그
  // 쓰기가 막으려던 부하를 대신 만든다 — rate-limit.ts 의 firstRejection 이
  // 감사 로그를 위해 존재하는 것과 같은 이유이고, 같은 값을 쓴다.
  // 「공격 한 번에 한 줄」이 여기서도 옳다.
  if (!decision.firstRejection) delete limited.logReason;
  return limited;
}
