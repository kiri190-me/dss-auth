import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL_INBOX_URL_ENV, readApprovalInboxUrl } from "./inbox-url";
import {
  APPROVAL_MAIL_SUBJECT,
  APPROVAL_TEST_MAIL_SUBJECT,
  buildApprovalMailMessage,
  buildApprovalTestMailMessage,
  countByApprovalKind,
  type ApprovalMailCountable,
} from "./mail-message";

/**
 * 메일의 글자.
 *
 * 🔴 두 가지를 잰다:
 *  ① **내용이 실리지 않는다** — 2026-10-23 결정. 메일은 바깥 메일 서버를 거쳐
 *     영구히 남고, 개인 메일로 자동 전달을 걸어 둔 사람이 있으면 막을 길이 없다.
 *  ② **제목에 숫자가 없다** — 잠금 화면 미리보기에 그대로 뜬다.
 *
 * 🔵 승인함 주소 읽기(inbox-url.ts)도 여기서 함께 잰다. 그 값이 가는 곳이
 * 이 본문 한 자리뿐이라, 따로 떼어 두면 둘이 어긋나도 눈에 안 띈다.
 */

const INBOX = "http://approvals.test:3900/";

/**
 * 🔴 **저쪽이 보내는 칸을 전부 붙인 줄.**
 *
 * 변수로 받아 넘기는 것이 요점이다 — 그래야 타입이 남는 칸을 잘라 내지 않고,
 * 본문에 그 글자가 섞이는지 실제로 잴 수 있다.
 */
const SECRETS = {
  subject: "삼성전자-2026-0101",
  detail: "결재선 2단계 · 요청자 홍길동 · 12,345,000원",
  kindLabel: "저쪽이-보낸-이름표",
  href: "http://as.test/quotes/9f1c/approval",
};

const LOADED_ROW = {
  clientId: "rf-service-system",
  kind: "QUOTE_APPROVAL",
  id: "QUOTE_APPROVAL:9f1c",
  ...SECRETS,
};

test("🔴 본문에 결재의 내용이 한 글자도 실리지 않는다", () => {
  const items: ApprovalMailCountable[] = [LOADED_ROW, LOADED_ROW];
  const message = buildApprovalMailMessage({ items, inboxUrl: INBOX });

  // 🔵 먼저 「무엇을 재는지」를 못 박는다 — 본문이 비면 아래 검사가 공짜로 통과한다.
  assert.ok(message.text.includes("결재할 건이 2건"), message.text);

  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(
      message.text.includes(value),
      false,
      `본문에 ${name}("${value}") 이 실렸다:\n${message.text}`
    );
    assert.equal(message.subject.includes(value), false, `제목에 ${name} 이 실렸다`);
  }
  // 결재건 열쇠도 싣지 않는다. 그 자체가 내용은 아니지만 건별 주소를 짓는 실마리다.
  assert.equal(message.text.includes("QUOTE_APPROVAL:9f1c"), false);
});

test("🔴 제목은 고정 글자이고 숫자가 없다 — 미리보기에 뜬다", () => {
  const message = buildApprovalMailMessage({
    items: [LOADED_ROW, LOADED_ROW, LOADED_ROW],
    inboxUrl: INBOX,
  });
  assert.equal(message.subject, APPROVAL_MAIL_SUBJECT);
  assert.equal(/[0-9]/.test(message.subject), false, `제목에 숫자가 있다: ${message.subject}`);
  assert.equal(/[0-9]/.test(APPROVAL_TEST_MAIL_SUBJECT), false);
});

test("갈래별 건수를 적는다 — 그것은 내용이 아니라 분류다", () => {
  const message = buildApprovalMailMessage({
    items: [
      { clientId: "dss-leave", kind: "LEAVE_REQUEST" },
      { clientId: "rf-service-system", kind: "REPAIR_INSPECTION" },
      { clientId: "dss-leave", kind: "LEAVE_REQUEST" },
    ],
    inboxUrl: INBOX,
  });

  assert.ok(message.text.includes("결재할 건이 3건 있습니다"));
  assert.ok(message.text.includes("· 접수건 검수 결재 1건"));
  assert.ok(message.text.includes("· 휴가 신청 결재 2건"));
  // 🔴 차례는 갈래 표의 차례다 — 메일마다 줄 차례가 흔들리면 안 된다.
  assert.ok(
    message.text.indexOf("접수건 검수 결재") < message.text.indexOf("휴가 신청 결재"),
    message.text
  );
});

test("갈래별 셈 — 건수가 0인 갈래는 줄이 생기지 않는다", () => {
  assert.deepEqual(
    countByApprovalKind([
      { clientId: "dss-inventory", kind: "PART_ISSUE_APPROVAL" },
      { clientId: "dss-inventory", kind: "PART_ISSUE_APPROVAL" },
    ]),
    [{ label: "부품 불출 결재", count: 2 }]
  );
});

test("모르는 갈래는 본문에 적지 않는다 — 포털에 적을 이름이 없다", () => {
  assert.deepEqual(countByApprovalKind([{ clientId: "dss-board", kind: "뭔가" }]), []);
});

test("승인함 주소는 첫 화면 하나만 적는다", () => {
  const message = buildApprovalMailMessage({ items: [LOADED_ROW], inboxUrl: INBOX });
  assert.ok(message.text.includes(INBOX));
  // 🔵 주소가 두 번 나오면 건별 링크를 넣기 시작했다는 뜻이다.
  assert.equal(message.text.split(INBOX).length - 1, 1);
});

test("주소가 없으면 그 줄만 빠지고 메일은 그대로 만들어진다", () => {
  const message = buildApprovalMailMessage({ items: [LOADED_ROW], inboxUrl: null });
  assert.ok(message.text.includes("결재할 건이 1건"));
  assert.equal(message.text.includes("http"), false, message.text);
});

test("시험 메일은 제목에 [시험] 이 붙고, 가짜 건수로 만들어진다", () => {
  const message = buildApprovalTestMailMessage(INBOX);
  assert.equal(message.subject, APPROVAL_TEST_MAIL_SUBJECT);
  assert.ok(message.subject.startsWith("[시험]"));
  assert.ok(message.text.includes("시험 메일입니다"));
  assert.ok(message.text.includes("예시값"));
  assert.ok(message.text.includes("결재할 건이 2건 있습니다"), message.text);
});

test("승인함 주소 읽기 — 없거나 모양이 틀리면 null 이다", () => {
  assert.equal(readApprovalInboxUrl({}), null);
  assert.equal(readApprovalInboxUrl({ [APPROVAL_INBOX_URL_ENV]: "   " }), null);
  assert.equal(readApprovalInboxUrl({ [APPROVAL_INBOX_URL_ENV]: "주소아님" }), null);
  // 🔴 메일 본문에 그대로 찍히는 글자다. http·https 가 아니면 받지 않는다.
  assert.equal(readApprovalInboxUrl({ [APPROVAL_INBOX_URL_ENV]: "ftp://x.test/" }), null);
  assert.equal(
    readApprovalInboxUrl({ [APPROVAL_INBOX_URL_ENV]: " https://approvals.dss21.co.kr/ " }),
    "https://approvals.dss21.co.kr/"
  );
});
