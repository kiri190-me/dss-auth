import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatheredApprovalItem, GatheredApprovals } from "./gather";
import { approvalKindKey } from "./kinds";
import { approvalDeliveryKey } from "./plan";
import {
  approvalMailRunFailed,
  describeApprovalMailRun,
  runApprovalMailJob,
  type ApprovalDeliveryRecord,
  type ApprovalMailRecipient,
  type ApprovalMailRunDeps,
  type ApprovalMailSendOutcome,
} from "./run";

/**
 * 작업 한 번의 흐름.
 *
 * 🔴 이 파일이 지키는 것들 — 하나라도 뚫리면 사람이 알아차리기 전에는 안 보인다:
 *  · 같은 결재를 **두 번 보내지 않는다**
 *  · 꺼 둔 갈래는 **보내지 않는다**(기본은 전부 끔)
 *  · 보낼 것이 0건이면 **메일을 안 보낸다**
 *  · 메일 주소가 없는 사람을 **조용히 건너뛰지 않는다**
 *  · 한 시스템이 죽어도 **나머지로 보낸다**
 *  · 🔴 본문에 **결재의 내용이 실리지 않는다**
 *
 * 🔵 이름과 메일 주소는 전부 가짜다(실제 사람을 넣지 않는다).
 */

const LEAVE_ON = approvalKindKey("dss-leave", "LEAVE_REQUEST");
const PART_ON = approvalKindKey("dss-inventory", "PART_ISSUE_APPROVAL");

const 사람하나: ApprovalMailRecipient = {
  userId: "user-1",
  displayName: "가나다",
  email: "one@example.test",
};
const 사람둘: ApprovalMailRecipient = {
  userId: "user-2",
  displayName: "라마바",
  email: "two@example.test",
};
const 주소없는사람: ApprovalMailRecipient = {
  userId: "user-3",
  displayName: "사아자",
  email: null,
};

/** 🔴 저쪽이 보내는 칸을 **전부 붙인** 줄. 본문에 새는지 재려고 일부러 들고 다닌다. */
const 내용이_붙은_줄 = {
  clientId: "dss-leave",
  kind: "LEAVE_REQUEST",
  id: "LEAVE_REQUEST:1",
  subject: "2026-11-02 ~ 11-04 연차",
  detail: "신청자 홍길동 · 잔여 3일",
  kindLabel: "저쪽이-보낸-이름표",
};

function item(clientId: string, kind: string, id: string): GatheredApprovalItem {
  return { clientId, kind, id };
}

/** 실패 갈래들은 서버 로그에 한 줄씩 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const [error, warn] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

function gathered(items: GatheredApprovalItem[], extra?: Partial<GatheredApprovals>): GatheredApprovals {
  return { items, outcomes: [], degraded: false, ...extra };
}

type Harness = {
  deps: ApprovalMailRunDeps;
  sent: { to: string; subject: string; text: string }[];
  recorded: { userId: string; rows: readonly ApprovalDeliveryRecord[] }[];
  gatherCalls: string[];
};

function harness(options: {
  recipients?: ApprovalMailRecipient[];
  enabled?: string[];
  gather?: (recipient: ApprovalMailRecipient) => GatheredApprovals;
  sentKeys?: (userId: string) => Set<string>;
  send?: (to: string) => ApprovalMailSendOutcome;
  record?: () => void;
  dryRun?: boolean;
  inboxUrl?: string | null;
}): Harness {
  const sent: Harness["sent"] = [];
  const recorded: Harness["recorded"] = [];
  const gatherCalls: string[] = [];

  const deps: ApprovalMailRunDeps = {
    listRecipients: async () => options.recipients ?? [사람하나],
    enabledKinds: async () => new Set(options.enabled ?? [LEAVE_ON, PART_ON]),
    gatherFor: async (recipient) => {
      gatherCalls.push(recipient.userId);
      return options.gather?.(recipient) ?? gathered([]);
    },
    sentKeysFor: async (userId) => options.sentKeys?.(userId) ?? new Set(),
    sendMail: async (params) => {
      sent.push(params);
      return options.send?.(params.to) ?? { ok: true };
    },
    recordDeliveries: async (params) => {
      options.record?.();
      recorded.push(params);
    },
    inboxUrl: options.inboxUrl === undefined ? "http://approvals.test/" : options.inboxUrl,
    dryRun: options.dryRun,
  };

  return { deps, sent, recorded, gatherCalls };
}

test("🔴 켜 둔 갈래가 하나도 없으면 아무에게도 묻지 않는다", async () => {
  const h = harness({
    enabled: [],
    recipients: [사람하나, 사람둘],
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
  });

  const report = await quiet(() => runApprovalMailJob(h.deps));

  assert.deepEqual(h.gatherCalls, []);
  assert.deepEqual(h.sent, []);
  assert.equal(report.enabledKindCount, 0);
  assert.equal(report.recipients, 0);
});

test("사람마다 **한 통** — 결재가 여러 건이어도 한 통이다", async () => {
  const h = harness({
    gather: () =>
      gathered([
        item("dss-leave", "LEAVE_REQUEST", "L:1"),
        item("dss-leave", "LEAVE_REQUEST", "L:2"),
        item("dss-inventory", "PART_ISSUE_APPROVAL", "P:1"),
      ]),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, "one@example.test");
  assert.ok(h.sent[0].text.includes("결재할 건이 3건"), h.sent[0].text);
  assert.ok(h.sent[0].text.includes("휴가 신청 결재 2건"));
  assert.ok(h.sent[0].text.includes("부품 불출 결재 1건"));
  assert.equal(report.mailed, 1);
  assert.equal(report.itemsMailed, 3);
});

test("🔴 본문에 결재의 내용이 실리지 않는다 — 저쪽이 칸을 다 보내도", async () => {
  const h = harness({ gather: () => gathered([내용이_붙은_줄]) });

  await runApprovalMailJob(h.deps);

  assert.equal(h.sent.length, 1, "메일이 한 통 나가야 아래 검사가 뜻이 있다");
  for (const 내용 of [내용이_붙은_줄.subject, 내용이_붙은_줄.detail, 내용이_붙은_줄.kindLabel]) {
    assert.equal(
      h.sent[0].text.includes(내용),
      false,
      `본문에 "${내용}" 이 실렸다:\n${h.sent[0].text}`
    );
  }
  assert.equal(/[0-9]/.test(h.sent[0].subject), false, "제목에 숫자가 있다");
});

test("🔴 이미 보낸 건만 있으면 메일을 보내지 않는다", async () => {
  const h = harness({
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
    sentKeys: () => new Set([approvalDeliveryKey("dss-leave", "L:1")]),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.recorded, []);
  assert.equal(report.nothingToSend, 1);
  assert.equal(report.skippedAlreadySent, 1);
});

test("🔴 보낼 것이 0건이면 메일을 안 보낸다 — 「오늘은 없습니다」 메일은 소음이다", async () => {
  const h = harness({ gather: () => gathered([]) });
  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(h.sent, []);
  assert.equal(report.mailed, 0);
  assert.equal(report.nothingToSend, 1);
});

test("🔴 꺼 둔 갈래는 보내지 않는다", async () => {
  const h = harness({
    enabled: [PART_ON],
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(h.sent, []);
  assert.equal(report.skippedDisabled, 1);
  assert.equal(report.nothingToSend, 1);
});

test("🔴 메일 주소가 없는 사람은 조용히 빠지지 않는다 — 묻지도 않는다", async () => {
  const h = harness({
    recipients: [주소없는사람, 사람하나],
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(report.skippedNoEmail, [{ userId: "user-3", displayName: "사아자" }]);
  // 주소가 없으면 물어볼 까닭도 없다 — 세 시스템을 괜히 두드리지 않는다.
  assert.deepEqual(h.gatherCalls, ["user-1"]);
  assert.equal(report.recipients, 2);
  assert.equal(report.mailed, 1);
  // 그리고 기록에 남은 글자로 「왜 안 갔나」를 바로 읽을 수 있어야 한다.
  assert.ok(describeApprovalMailRun(report).some((line) => line.includes("사아자")));
});

test("🔴 한 시스템이 죽어도 나머지 시스템의 결재로 메일이 나간다", async () => {
  const h = harness({
    gather: () =>
      gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")], {
        degraded: true,
        outcomes: [
          { clientId: "dss-inventory", status: "failed", reason: "ECONNREFUSED" },
          { clientId: "dss-leave", status: "ok", count: 1 },
        ],
      }),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.equal(h.sent.length, 1);
  assert.deepEqual(report.failedSources, [
    { userId: "user-1", clientId: "dss-inventory", reason: "ECONNREFUSED" },
  ]);
  // 🔴 못 물어본 시스템 하나로는 작업이 실패가 아니다.
  assert.equal(approvalMailRunFailed(report), false);
});

test("🔴 휴가의 계정 미연결은 「결재가 없다」와 따로 적힌다", async () => {
  const h = harness({
    gather: () =>
      gathered([], {
        outcomes: [{ clientId: "dss-leave", status: "unavailable", reason: "employee_not_linked" }],
      }),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(report.unavailableSources, [
    { userId: "user-1", clientId: "dss-leave", reason: "employee_not_linked" },
  ]);
  assert.deepEqual(report.failedSources, []);
  assert.equal(report.nothingToSend, 1);
});

test("보낸 뒤 기록을 남긴다 — 열쇠는 (사람, 시스템, 결재건 id) 다", async () => {
  const h = harness({ gather: () => gathered([내용이_붙은_줄]) });

  await runApprovalMailJob(h.deps);

  assert.deepEqual(h.recorded, [
    {
      userId: "user-1",
      rows: [
        {
          clientId: "dss-leave",
          itemId: "LEAVE_REQUEST:1",
          kind: "LEAVE_REQUEST",
          status: "SENT",
          error: null,
        },
      ],
    },
  ]);
  // 🔴 기록에도 내용이 들어가지 않는다.
  const dump = JSON.stringify(h.recorded);
  assert.equal(dump.includes(내용이_붙은_줄.subject), false, dump);
  assert.equal(dump.includes(내용이_붙은_줄.detail), false, dump);
});

test("🔴 보내기에 실패하면 실패로 적고 다음 사람을 계속한다 — 다음 번에 다시 보낸다", async () => {
  const h = harness({
    recipients: [사람하나, 사람둘],
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
    send: (to) =>
      to === "one@example.test"
        ? { ok: false, message: "550 mailbox unavailable" }
        : { ok: true },
  });

  const report = await runApprovalMailJob(h.deps);

  assert.equal(h.sent.length, 2, "두 번째 사람에게도 보내야 한다");
  assert.deepEqual(h.recorded[0].rows[0].status, "FAILED");
  assert.equal(h.recorded[0].rows[0].error, "550 mailbox unavailable");
  assert.deepEqual(h.recorded[1].rows[0].status, "SENT");
  assert.deepEqual(report.sendFailures, [
    { userId: "user-1", message: "550 mailbox unavailable" },
  ]);
  assert.equal(report.mailed, 1);
  assert.equal(approvalMailRunFailed(report), true);
});

test("🔴 메일 설정 자체가 없으면 그 자리에서 멈춘다 — 남은 사람에게 되풀이하지 않는다", async () => {
  const h = harness({
    recipients: [사람하나, 사람둘],
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
    send: () => ({ ok: false, message: "메일 설정이 비어 있습니다", configMissing: true }),
  });

  const report = await quiet(() => runApprovalMailJob(h.deps));

  assert.equal(h.sent.length, 1, "두 번째 사람에게는 보내려 하지도 않아야 한다");
  assert.deepEqual(h.recorded, [], "설정이 없는데 실패 기록을 쌓지 않는다");
  assert.equal(report.stoppedForMailConfig, true);
  assert.equal(approvalMailRunFailed(report), true);
});

test("🔴 기록을 못 남겨도 던지지 않는다 — 메일은 이미 나갔고, 내일 한 번 더 간다", async () => {
  const h = harness({
    gather: () => gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]),
    record: () => {
      throw new Error("DB 가 없다");
    },
  });

  const report = await quiet(() => runApprovalMailJob(h.deps));

  assert.equal(h.sent.length, 1);
  assert.deepEqual(report.recordFailures, [{ userId: "user-1", message: "DB 가 없다" }]);
  assert.equal(report.mailed, 1);
  assert.equal(approvalMailRunFailed(report), true);
});

test("한 사람 차례가 통째로 깨져도 나머지 사람은 계속 돈다", async () => {
  const h = harness({
    recipients: [사람하나, 사람둘],
    gather: (recipient) => {
      if (recipient.userId === "user-1") throw new Error("보낸 기록을 읽지 못했다");
      return gathered([item("dss-leave", "LEAVE_REQUEST", "L:1")]);
    },
  });

  const report = await quiet(() => runApprovalMailJob(h.deps));

  assert.deepEqual(report.userErrors, [
    { userId: "user-1", message: "보낸 기록을 읽지 못했다" },
  ]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, "two@example.test");
});

test("🔵 --dry-run 은 보내지도 적지도 않고 셈만 한다", async () => {
  const h = harness({
    dryRun: true,
    gather: () =>
      gathered([
        item("dss-leave", "LEAVE_REQUEST", "L:1"),
        item("dss-leave", "LEAVE_REQUEST", "L:2"),
      ]),
  });

  const report = await runApprovalMailJob(h.deps);

  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.recorded, []);
  assert.equal(report.dryRun, true);
  assert.equal(report.mailed, 1);
  assert.equal(report.itemsMailed, 2);
  assert.ok(describeApprovalMailRun(report)[0].includes("--dry-run"));
});

test("작업 기록은 0 인 줄도 적는다 — 「돌기는 했는지」를 나중에 알아야 한다", async () => {
  const h = harness({ gather: () => gathered([]) });
  const report = await runApprovalMailJob(h.deps);
  const lines = describeApprovalMailRun(report);

  assert.ok(lines.some((line) => line.includes("대상 1명")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("메일 0통")), lines.join("\n"));
  assert.equal(approvalMailRunFailed(report), false);
});
