import { APPROVAL_MAIL_KINDS, findApprovalMailKind } from "./kinds";

/**
 * ============================================================================
 * 결재 알림 메일의 글자 — 🔴 **내용을 싣지 않는다** (2026-10-23 결정)
 * ============================================================================
 * 본문에 들어가는 것은 셋뿐이다: **건수**, **갈래별 건수**, **승인함 주소 하나.**
 * 고객사 · 금액 · 품명 · 사람 이름 · 인수번호는 한 글자도 싣지 않는다.
 *
 * 까닭:
 *  · 메일은 외부 호스팅(smtp.cafe24.com)을 거치고 **본문이 영구히 남는다.**
 *  · 직원이 개인 메일로 **자동 전달**을 걸어 두면 사내 결재 내용이 그대로 밖으로
 *    나간다 — 막을 길이 없다.
 *  · 「승인할 게 있다」는 사실만 보내면 전달돼도 **무해**하다.
 *
 * 🔵 갈래별 건수는 적어도 된다. 그것은 내용이 아니라 **분류**이고, 받는 사람이
 * 「지금 승인함을 열어야 하는가」를 정하는 데 실제로 쓰인다.
 *
 * 🔴 **제목에는 숫자도 넣지 않는다.** 잠금 화면과 메일 목록의 미리보기에 제목이
 * 그대로 뜨기 때문이다 — 「결재 3건」은 옆 사람 화면에서도 읽힌다.
 *
 * ── 🔴 이 파일이 저쪽 글자를 쓸 수 없게 되어 있다 ─────────────────────────
 * 갈래 이름은 **포털이 가진 상수**(approvals/kinds.ts 의 `label`)에서만 온다.
 * 저쪽이 보낸 `kindLabel`·`subject`·`detail` 은 애초에 포털로 들어오지 않는다
 * (approvals/inbox.ts 가 `id`·`kind` 만 꺼낸다). 그래서 이 함수가 받는 값에는
 * **실을 수 있는 내용 자체가 없다** — 조심해서 지키는 약속이 아니라 구조로
 * 지켜지는 약속이다.
 *
 * ── 평문 한 벌만 보낸다 ───────────────────────────────────────────────────
 * HTML 판을 만들지 않는다. 꾸밀 내용이 없고, 평문에는 **숨은 글자도 바깥
 * 그림(열람 추적)도 들어갈 자리가 없다.** 어느 메일 프로그램에서나 같은 글자로
 * 보이는 것도 이득이다.
 * ============================================================================
 */

/**
 * 🔴 제목은 **고정 글자**다. 숫자도, 갈래 이름도 넣지 않는다(머리말).
 *
 * 🔵 앞의 `[DSS]` 는 받는 사람이 메일함에서 규칙을 걸 수 있게 하는 표시다.
 */
export const APPROVAL_MAIL_SUBJECT = "[DSS] 결재할 건이 있습니다";

/** 시험 메일의 제목. 받은 편지함에서 **진짜 알림과 섞이면 안 된다.** */
export const APPROVAL_TEST_MAIL_SUBJECT = "[시험] [DSS] 결재할 건이 있습니다";

/** 본문 맨 아래에 늘 붙는 말. 「왜 내용이 없는지」를 받는 사람에게 설명한다. */
const FOOTER = [
  "────────────────────────────────",
  "이 메일은 DSS 통합 로그인이 자동으로 보냈습니다.",
  "건의 내용(고객사 · 금액 · 품명 · 사람 이름 · 인수번호)은 일부러 싣지 않습니다 —",
  "메일은 밖으로 전달될 수 있기 때문입니다. 승인함을 열어 확인해 주십시오.",
].join("\n");

export type ApprovalMailMessage = {
  subject: string;
  /** 평문 한 벌. 🔴 HTML 판은 만들지 않는다(머리말). */
  text: string;
};

/** 메일 본문을 만들 때 쓰는 전부. 🔴 칸을 늘리지 마라 — 내용이 실리는 길이 된다. */
export type ApprovalMailCountable = {
  clientId: string;
  kind: string;
};

/**
 * 갈래별 건수. 🔴 차례는 `APPROVAL_MAIL_KINDS` 의 차례다 — 메일마다 줄 차례가
 * 달라지면 받는 사람이 매번 다시 읽어야 한다.
 *
 * 🔵 모르는 갈래는 애초에 여기까지 오지 않는다(approvals/plan.ts 가 먼저 뺀다).
 * 그래도 한 번 더 거르는 까닭은, 이 함수가 **혼자서도 안전해야** 다른 자리에서
 * 불러 쓸 때 사고가 안 나기 때문이다.
 */
export function countByApprovalKind(
  items: readonly ApprovalMailCountable[]
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const entry = findApprovalMailKind(item.clientId, item.kind);
    if (!entry) continue;
    const key = `${entry.clientId}:${entry.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return APPROVAL_MAIL_KINDS.flatMap((entry) => {
    const count = counts.get(`${entry.clientId}:${entry.kind}`) ?? 0;
    return count === 0 ? [] : [{ label: entry.label, count }];
  });
}

/**
 * 본문을 만든다.
 *
 * 🔵 `inboxUrl` 이 없으면(환경변수를 아직 안 적었으면) **주소 줄만 빠진다.**
 * 메일을 안 보내지는 않는다 — 「결재할 것이 있다」는 사실은 주소 없이도 뜻이
 * 있고, 주소가 빠진 것은 관리자 화면과 작업 기록이 크게 알린다.
 */
export function buildApprovalMailMessage(params: {
  items: readonly ApprovalMailCountable[];
  inboxUrl: string | null;
}): ApprovalMailMessage {
  const lines: string[] = [];
  const total = countByApprovalKind(params.items).reduce((sum, row) => sum + row.count, 0);

  lines.push(`결재할 건이 ${total}건 있습니다. 통합 승인함에서 확인해 주십시오.`);
  lines.push("");
  for (const row of countByApprovalKind(params.items)) {
    lines.push(`  · ${row.label} ${row.count}건`);
  }
  lines.push("");
  if (params.inboxUrl !== null) {
    // 🔵 건별 주소를 넣지 않는다. 메일 속 링크를 눌러 들어가는 습관이 붙으면
    //    그것이 그대로 피싱에 당하는 습관이 된다 — 늘 같은 첫 화면 하나만 적는다.
    lines.push(params.inboxUrl);
    lines.push("");
  }
  lines.push(FOOTER);

  return { subject: APPROVAL_MAIL_SUBJECT, text: lines.join("\n") };
}

/**
 * [시험 메일 보내기] 가 보내는 글자.
 *
 * 🔴 **가짜 건수로 만든다.** 실제 결재를 끌어오지 않는다 — 이 단추의 목적은
 * 「메일 설정이 맞는가」를 확인하는 것이고, 시험 메일에 진짜 건수가 실릴 까닭이
 * 없다(A/S 의 시험 메일이 예시값을 쓰는 것과 같은 판단).
 *
 * 🔵 그래서 본문의 **모양은 진짜와 같다** — 받는 사람이 실제로 받게 될 글자를
 * 눈으로 확인할 수 있어야 켜고 끄는 판단을 할 수 있다.
 */
export function buildApprovalTestMailMessage(inboxUrl: string | null): ApprovalMailMessage {
  const sample = buildApprovalMailMessage({
    // 🔵 가짜다. 갈래만 빌려 오고 건수는 지어낸 값이다.
    items: [
      { clientId: "rf-service-system", kind: "REPAIR_INSPECTION" },
      { clientId: "dss-leave", kind: "LEAVE_REQUEST" },
    ],
    inboxUrl,
  });

  return {
    subject: APPROVAL_TEST_MAIL_SUBJECT,
    text: [
      "※ 이 메일은 「알림 설정」 화면에서 보낸 시험 메일입니다.",
      "※ 아래 건수는 예시값이며, 받는 사람은 보낸 사람 본인 한 명뿐입니다.",
      "",
      sample.text,
    ].join("\n"),
  };
}
