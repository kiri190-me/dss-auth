import {
  authorizeSiteSubject,
  checkSiteCredentials,
  MAX_SUBJECT_LENGTH,
  NO_STORE,
  reject,
  verifySiteClient,
  type SiteFeedResponse,
  type SiteRequestDeps,
} from "@/lib/notifications/site-feed";

/**
 * ============================================================================
 * 「이 사람에게 결재할 것이 생겼다」를 받는 통로 — 판정 전부
 * ============================================================================
 *   POST {포털}/api/integration/approval-created
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   approverSub=<포털 users.id>&approverSub=<포털 users.id>&…
 *
 * 답(202): { accepted, skipped, dropped }
 *
 * ── 🔴 오는 것은 **사람 번호뿐이다** ──────────────────────────────────────
 * 건 번호도 갈래도 제목도 안 온다. 포털은 이 신호를 받고 **제 통로로 그 사람의
 * 결재를 다시 물어**(approvals/notice-run.ts) 아직 안 보낸 것에만 메일을 띄운다.
 * 그래서 저쪽이 거짓을 보내도 **메일 내용이 흔들리지 않는다** — 저쪽이 할 수
 * 있는 최대는 「그 사람 몫 작업을 한 번 더 돌리게 하는 것」이고, 그것은 보낸
 * 기록이 그대로 막는다.
 *
 * 🔴 **그러므로 칸을 늘리지 마라.** 「어느 건인지도 같이 보내면 편하지 않나」가
 * 이 설계를 무너뜨리는 한 줄이다 — 그 순간 메일 본문에 저쪽 글자가 실릴 길이
 * 열린다(approvals/inbox.ts 의 울타리와 한 쌍이다).
 *
 * ── 🔴 문 여섯을 베끼지 않았다 ────────────────────────────────────────────
 * 이 방향(사이트 → 포털)의 통로는 이제 다섯이고, 앞의 넷은
 * `authorizeSiteRequest` 한 벌을 그대로 쓴다. 여기만 그러지 못하는 까닭은 본문이
 * 다르기 때문이다 — 저쪽은 `sub` **하나**이고 여기는 `approverSub` **여럿**이다.
 * 그래서 베끼는 대신 문 여섯을 세 토막으로 꺼내 쓴다(notifications/site-feed.ts
 * 의 `checkSiteCredentials` · `verifySiteClient` · `authorizeSiteSubject`).
 * 판정 자체는 그 파일 한 곳에 있으므로 갈라질 길이 없다.
 *
 * ── 🔴 본문 검사가 **시스템 확인 뒤**다 — 앞의 넷과 반대다 ────────────────
 * 읽기·지움·확인·결재함은 본문의 `sub` 를 DB 조회보다 **앞**에서 본다. 여기서는
 * 뒤로 돌렸다. 까닭은 site-dismissals.ts 가 열쇠 검사를 문 여섯 뒤에 둔 것과
 * 같다: 자격증명 없이 400 과 401 을 갈라 보는 것만으로 **이 통로가 어떤 모양을
 * 받는지**를 짚어 낼 수 있게 두지 않는다. 🔵 잃는 것은 「모양이 틀린 요청에도
 * 조회가 한 번 돈다」인데, 그 조회는 어차피 자격증명이 맞는 쪽에서만 돈다.
 *
 * ── 🔴 모르는 사람은 **조용히 건너뛴다** ──────────────────────────────────
 * 없는 사람 · 정지된 사람 · 그 시스템에 들어갈 수 없는 사람은 세기만 하고
 * 아무 일도 하지 않는다. 그 셋을 갈라 400 으로 돌려주면 이 통로가 **포털 사용자
 * 목록과 접근 권한을 묻는 조회 도구**가 된다 — 앞의 넷이 401·403 을 한 얼굴로
 * 돌려주며 막아 둔 바로 그 조회다(site-feed.ts 의 `forbidden`).
 *
 * 🔵 숫자(`accepted`·`skipped`)는 돌려준다. 가르지 않은 합이라 「누가」를 말하지
 * 않고, 붙이는 쪽은 배포가 어긋났을 때 이 숫자로만 알아챌 수 있다. 🔴 그래도
 * 조회 도구이기는 하므로(번호를 하나씩 넣어 보면 센 수가 달라진다) **문 ⑥ 이
 * 반드시 걸려야 한다** — 그 시스템을 쓸 수 없는 사람은 어차피 0 이다.
 *
 * ── 🔴 빨리 답하고, 메일은 뒤에서 ────────────────────────────────────────
 * 부르는 자리는 사람이 [신청] 단추를 누르고 **화면 앞에서 서 있는** 자리다
 * (저쪽은 2초 상한을 걸고 기다린다 — A/S 의 portal-inbox.ts). 메일 한 통은 몇
 * 초가 걸릴 수 있으므로, 여기서는 **받았다는 답(202)만** 돌려주고 메일 일은
 * `deps.schedule` 에 넘긴다. 라우트가 거기에 Next 의 `after` 를 끼운다.
 *
 * 🔴 **넘긴 일은 여기서 전부 잡는다.** 응답이 나간 뒤에 던지면 받아 줄 사람이
 * 없고, 잡히지 않은 거절은 **일곱 사이트의 로그인을 떠받치는 포털 프로세스**를
 * 죽일 수 있다. 그래서 `deps.notify` 가 던져도 넘긴 일 자체는 절대 거절하지
 * 않는다.
 *
 * ── 왜 라우트가 아니라 여기인가 ──────────────────────────────────────────
 * 앞의 넷과 같다. 이 통로의 값어치도 **거절이 제대로 되는가**와 **겹침을 막는가**
 * 에 달려 있고, 라우트 안에 두면 DB 와 메일 서버가 붙어 있어 시험이 그것들을
 * 돌려 볼 수 없다. 🔵 「기다리지 않는다」도 여기서만 잴 수 있다 — 시험이
 * `schedule` 에 **안 돌리는 가짜**를 끼워 답이 먼저 나오는지 본다.
 * ============================================================================
 */

/**
 * 한 번에 실을 수 있는 사람 수.
 *
 * 🔴 **넘으면 통째로 거절한다 — 앞의 몇만 받아 주지 않는다**(지움 통로와 같은
 * 규약). 결재 하나의 결재자가 수십 명일 까닭이 없으므로, 이보다 많이 온다면
 * 부르는 쪽이 사람 목록을 잘못 만든 것이다. 조용히 잘라 주면 그 사고가
 * 「몇몇은 메일을 못 받는다」로만 드러나 원인을 가리키지 않는다.
 */
export const MAX_APPROVERS_PER_REQUEST = 50;

export type ApprovalCreatedDeps<C extends { clientId: string }> = SiteRequestDeps<C> & {
  /**
   * 그 사람 몫 결재 메일을 **지금** 돌린다.
   *
   * 🔴 **응답 뒤에 불린다.** 던져도 아래에서 받아 삼키지만, 삼키는 것은 마지막
   * 그물이다 — 이 함수 자신이 안 던지게 지어져 있어야 한다
   * (approvals/notice-run.ts 는 그렇다).
   */
  notify(params: { userId: string }): Promise<void>;
  /**
   * 응답과 **떼어 낸** 일감 하나를 맡긴다. 라우트가 Next 의 `after` 를 끼운다.
   *
   * 🔴 **돌려받는 것이 없다**(void). 기다릴 수 있게 Promise 를 돌려주면 누군가
   * 언젠가 `await` 를 붙이고, 그 순간 이 통로는 다시 메일을 기다리게 된다.
   */
  schedule(task: () => Promise<void>): void;
};

/** 본문에서 읽어 낸 결과. */
type ReadApprovers =
  | { ok: true; subjects: string[]; dropped: number }
  | { ok: false; response: SiteFeedResponse };

/**
 * 본문에서 사람 번호들을 읽는다. 🔴 **던지지 않는다.**
 *
 * 🔵 모양이 틀린 값(빈 값 · 터무니없이 긴 값)은 **조용히 버리고 센다.** 한 값
 * 때문에 묶음 전체가 거절되면, 보내는 쪽은 나머지 사람의 메일까지 잃는다
 * (지움 통로가 모양 틀린 열쇠를 `dropped` 로 버리는 것과 같은 판단).
 */
function readApproverSubjects(body: string): ReadApprovers {
  const raw = new URLSearchParams(body)
    .getAll("approverSub")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (raw.length === 0) {
    return {
      ok: false,
      response: reject(
        400,
        "invalid_request",
        "approverSub 가 필요합니다. 결재할 사람의 포털 번호(ID 토큰의 sub)를 보내세요.",
        "no_approver"
      ),
    };
  }

  if (raw.length > MAX_APPROVERS_PER_REQUEST) {
    // 🔴 **「나눠 보내라」가 들어 있어야 한다.** 이 말이 없으면 붙이는 쪽은 400 을
    //    받고도 무엇을 고쳐야 하는지 모른다(지움 통로와 같은 까닭).
    return {
      ok: false,
      response: reject(
        400,
        "invalid_request",
        `한 번에 보낼 수 있는 사람은 ${MAX_APPROVERS_PER_REQUEST}명입니다. ${MAX_APPROVERS_PER_REQUEST}명씩 나눠 보내세요.`,
        "too_many_approvers"
      ),
    };
  }

  // 🔴 터무니없이 긴 값은 **조회하지 않고** 버린다 — 없으면 수 MB 짜리 문자열로
  //    DB 조회를 돌리게 만들 수 있다(site-feed.ts 의 `MAX_SUBJECT_LENGTH`).
  const wellFormed = raw.filter((value) => value.length <= MAX_SUBJECT_LENGTH);

  // 같은 사람이 두 번 실려 와도 한 번만 돌린다. 두 번 돌려도 메일은 한 통이지만
  // (보낸 기록이 막는다) 같은 일감을 두 번 만들 까닭이 없다.
  const subjects = Array.from(new Set(wellFormed));

  return { ok: true, subjects, dropped: raw.length - wellFormed.length };
}

/**
 * 한 번의 요청을 끝까지 판정하고 메일 일감을 **뒤로 넘긴다.**
 *
 * 🔴 **판정 자체는 던지지 않는다**(문들은 무엇이 와도 값을 돌려준다). 남은 것은
 * DB 조회 셋(`findActiveClient`·`findUser`·`hasAccess`)뿐이고, 그것이 던지는 경우는
 * **DB 가 죽은 때**라 라우트가 503 으로 받는다 — 결재함 통로의 `inboxFor` 와 같은
 * 모양이다. 🔵 **여기서 삼키면 안 된다**: 삼키면 DB 가 죽은 동안에도 202 를
 * 돌려주고, 저쪽은 「알렸다」고 믿은 채 다시 보내지 않는다.
 *
 * 🔴 **맡긴 일감은 절대 거절하지 않는다** — 그쪽은 응답 뒤에 돌아서 받아 줄
 * 사람이 없다(아래 `schedule` 자리의 주석).
 *
 * 🔴 답에는 **`no-store` 가 붙는다**(성공도 거절도). 이 답은 「지금 이 요청을
 * 받았다」는 말이라 어디에 남아도 뜻이 달라진다.
 */
export async function handleApprovalCreatedRequest<C extends { clientId: string }>(
  request: Request,
  deps: ApprovalCreatedDeps<C>
): Promise<SiteFeedResponse> {
  // ①② 주소와 머리말. DB 를 건드리기 전에 끝난다.
  const credentials = checkSiteCredentials(request, deps);
  if (!credentials.ok) return credentials.response;

  // ④ 부르는 쪽이 등록된 그 시스템인가. 🔴 **본문보다 먼저**다(머리말).
  const verified = await verifySiteClient(credentials.credentials, deps);
  if (!verified.ok) return verified.response;

  let body: string;
  try {
    body = await request.text();
  } catch {
    return reject(400, "invalid_request", "요청 본문을 읽을 수 없습니다.", "unreadable_body");
  }

  const read = readApproverSubjects(body);
  if (!read.ok) return read.response;

  /*
    ⑤⑥ 사람마다 **같은 두 문**을 지난다 — 지금 쓸 수 있는 계정인가, 그리고 그
    시스템이 그 사람을 볼 수 있는가. 🔴 막힌 사람은 **조용히 건너뛴다**(머리말).

    🔵 사람마다 차례로 본다. 한꺼번에 던지면(Promise.all) 왕복 몇 번만큼 빠르지만,
    여기 오는 사람 수는 보통 하나나 둘이고 상한이 50 이다 — 50개의 조회를 한꺼번에
    여는 쪽이 포털 DB 에 더 나쁘다.
  */
  const accepted: string[] = [];
  let skipped = 0;
  for (const subject of read.subjects) {
    const allowed = await authorizeSiteSubject(subject, verified.client, deps);
    if (!allowed.ok) {
      skipped += 1;
      // 🔴 **까닭 하나만** 남긴다 — 사람 번호도 비밀값도 적지 않는다(앞의 넷과
      //    같은 규약). 이 한 줄이 없으면 증상이 「저 사람만 메일이 안 온다」
      //    하나뿐이고, 그것으로는 계정 상태인지 권한인지 알 수 없다.
      console.warn(
        `[approvals-notice] 결재 생성 알림에서 한 사람을 건너뜁니다 (${allowed.response.logReason ?? "unknown"})`
      );
      continue;
    }
    accepted.push(subject);
  }

  /*
    🔴 **여기서 메일을 기다리지 않는다.** 아래는 일감을 맡기기만 하고 바로
    돌아간다 — 저쪽은 사람이 단추를 누른 자리에서 2초 상한을 걸고 기다리고 있다.

    🔴 **맡긴 일은 절대 거절하지 않는다.** 응답이 나간 뒤라 받아 줄 사람이 없고,
    잡히지 않은 거절은 포털 프로세스를 죽일 수 있다. `deps.notify` 가 스스로
    안 던지게 지어져 있어도(notice-run.ts) 여기서 한 겹 더 받는다 — 이 그물은
    「notify 를 다른 것으로 갈아 끼우는 날」을 위한 것이다.

    🔵 사람과 사람 사이는 **순서대로** 돈다. 한꺼번에 던지면 사내 시스템 셋에
    (사람 수 × 3) 개의 요청이 동시에 꽂힌다 — 응답 뒤에 도는 일이라 서두를
    까닭이 없다(approvals/run.ts 와 같은 판단).
  */
  if (accepted.length > 0) {
    deps.schedule(async () => {
      for (const userId of accepted) {
        try {
          await deps.notify({ userId });
        } catch (error) {
          console.error(`[approvals-notice] user ${userId} 몫 메일 일감이 깨졌습니다:`, error);
        }
      }
    });
  }

  return {
    status: 202,
    body: {
      /**
       * 🔴 **「메일이 나갔다」가 아니다.** 일감을 받았다는 뜻뿐이고, 실제로 메일이
       * 나가는지는 갈래 설정과 보낸 기록이 정한다 — 그 판단은 응답 뒤에 돈다.
       * 202 를 고른 까닭도 그것이다: 200 으로 답하면 붙이는 쪽이 「보냈구나」로
       * 읽고, 언젠가 그 값으로 사람에게 「메일을 보냈습니다」를 띄운다.
       */
      accepted: accepted.length,
      /** 없는 사람 · 정지된 사람 · 이 시스템을 쓸 수 없는 사람. 🔴 **가르지 않는다.** */
      skipped,
      /** 모양이 틀려 조용히 버린 값. 0 이 아니면 부르는 쪽의 배포가 어긋난 것이다. */
      dropped: read.dropped,
    },
    headers: NO_STORE,
  };
}
