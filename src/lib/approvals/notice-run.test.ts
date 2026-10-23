import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalDeliveryClaim, ApprovalDeliveryClaimed } from "@/lib/db/mutations/approval-mail-claims";
import {
  APPROVAL_DELIVERY_SENDING,
  APPROVAL_SENDING_LEASE_MS,
  countsAsSentApproval,
  sentApprovalKeysFrom,
  type ApprovalDeliveryState,
} from "./delivery-state";
import type { GatheredApprovals } from "./gather";
import { approvalKindKey } from "./kinds";
import { runApprovalNoticeForUser, type ApprovalNoticeDeps } from "./notice-run";
import { selectApprovalsToMail } from "./plan";
import type { ApprovalDeliveryRecord, ApprovalMailRecipient } from "./run";

/**
 * ============================================================================
 * 🔴 **같은 결재는 한 번만 간다** — 세 가지 겹침을 각각 재야 한다
 * ============================================================================
 *  ① 즉시 알림이 **두 번** 들어온다(결재를 올리고 반려했다 다시 올림).
 *  ② 즉시 알림과 **주기 작업**이 같은 건을 본다.
 *  ③ 🔴 즉시 알림 **둘이 동시에** 들어온다(결재 둘이 1초 사이에 생김).
 *
 * ③ 이 가장 어렵고, ①② 만 재면 **「조회하고 보내기」로도 통과한다.** 그래서
 * 아래 가짜 표는 진짜 SQL 의 조건을 그대로 흉내 낸다:
 *
 *   찍기(claim)는 **이미 있는 줄이 「보냈다」로 읽히면 아무것도 안 한다.**
 *   「보냈다」의 판정은 `countsAsSentApproval` 하나다 — 가짜 표도 진짜 SQL 의
 *   `setWhere` 도 그 함수의 **반대**를 쓴다(mutations/approval-mail-claims.ts).
 *
 * 🔵 그리고 찍기는 **동기적으로** 상태를 바꾼다. 자바스크립트가 한 줄기라 그
 * 구간에는 다른 요청이 끼어들 수 없고, 그것이 Postgres 가 같은 열쇠의 두
 * `INSERT … ON CONFLICT` 를 세워 두는 것과 같은 성질이다.
 * ============================================================================
 */

/** 🔴 전부 가짜다. 실제 계정의 이름도 메일 주소도 적지 않는다. */
const USER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT: ApprovalMailRecipient = {
  userId: USER,
  displayName: "결재자1",
  email: "approver1@example.test",
};

const AS_KIND = approvalKindKey("rf-service-system", "REPAIR_INSPECTION");
const LEAVE_KIND = approvalKindKey("dss-leave", "LEAVE_REQUEST");

/** 저쪽이 보내 온 결재건 둘. 🔴 들여온 칸은 둘뿐이다(approvals/inbox.ts). */
const ITEM_AS = { clientId: "rf-service-system", id: "REPAIR:7:INSPECTION", kind: "REPAIR_INSPECTION" };
const ITEM_LEAVE = { clientId: "dss-leave", id: "LEAVE-2026-0003", kind: "LEAVE_REQUEST" };

function gathered(items: readonly { clientId: string; id: string; kind: string }[]): GatheredApprovals {
  return {
    items: [...items],
    outcomes: [...new Set(items.map((item) => item.clientId))].map((clientId) => ({
      clientId,
      status: "ok" as const,
      count: items.filter((item) => item.clientId === clientId).length,
    })),
    degraded: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 가짜 기록 표 — 진짜 SQL 의 조건을 그대로 흉내 낸다(머리말)                  */
/* ────────────────────────────────────────────────────────────────────────── */

type StoredRow = ApprovalDeliveryState & { userId: string; kind: string; error: string | null };

function makeTable(startAt = new Date("2026-10-24T09:00:00.000Z")) {
  const rows: StoredRow[] = [];
  let now = startAt;

  const find = (userId: string, clientId: string, itemId: string) =>
    rows.find((row) => row.userId === userId && row.clientId === clientId && row.itemId === itemId);

  return {
    rows,
    /** 시계를 민다 — 수명이 지난 「보내는 중」을 재려고. */
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },

    /**
     * 🔴 `claimApprovalMailDeliveries` 의 흉내. 진짜 쪽의 `setWhere` 는
     * `countsAsSentApproval` 의 **반대**이고, 여기도 그 함수를 그대로 쓴다.
     */
    async claim(params: {
      userId: string;
      rows: readonly ApprovalDeliveryClaim[];
    }): Promise<readonly ApprovalDeliveryClaimed[]> {
      const claimed: ApprovalDeliveryClaimed[] = [];
      for (const wanted of params.rows) {
        const existing = find(params.userId, wanted.clientId, wanted.itemId);
        if (existing !== undefined) {
          if (countsAsSentApproval(existing, now)) continue; // 이미 보냈거나 보내는 중
          existing.status = APPROVAL_DELIVERY_SENDING;
          existing.kind = wanted.kind;
          existing.error = null;
          existing.sentAt = now;
        } else {
          rows.push({
            userId: params.userId,
            clientId: wanted.clientId,
            itemId: wanted.itemId,
            kind: wanted.kind,
            status: APPROVAL_DELIVERY_SENDING,
            error: null,
            sentAt: now,
          });
        }
        claimed.push({ clientId: wanted.clientId, itemId: wanted.itemId });
      }
      return claimed;
    },

    /** `recordApprovalMailDeliveries` 의 흉내(upsert). */
    async settle(params: { userId: string; rows: readonly ApprovalDeliveryRecord[] }) {
      for (const update of params.rows) {
        const existing = find(params.userId, update.clientId, update.itemId);
        if (existing === undefined) {
          rows.push({
            userId: params.userId,
            clientId: update.clientId,
            itemId: update.itemId,
            kind: update.kind,
            status: update.status,
            error: update.error,
            sentAt: now,
          });
          continue;
        }
        existing.status = update.status;
        existing.kind = update.kind;
        existing.error = update.error;
        existing.sentAt = now;
      }
    },

    /** `listSentApprovalKeys` 의 흉내 — 🔴 **진짜 판정 함수를 그대로 쓴다.** */
    async sentKeysFor(userId: string): Promise<ReadonlySet<string>> {
      return sentApprovalKeysFrom(
        rows.filter((row) => row.userId === userId),
        now
      );
    },

    /** 🔵 주기 작업이 지금 이 사람에게 **무엇을 보낼 것인가.** */
    async whatThePeriodicJobWouldSend(
      userId: string,
      items: readonly { clientId: string; id: string; kind: string }[],
      enabledKeys: ReadonlySet<string>
    ) {
      return selectApprovalsToMail({
        items,
        enabledKeys,
        alreadySent: await this.sentKeysFor(userId),
      }).toSend;
    },
  };
}

type Sent = { to: string; subject: string; text: string };

function makeDeps(
  over: {
    table?: ReturnType<typeof makeTable>;
    enabled?: string[];
    recipient?: ApprovalMailRecipient | null;
    items?: readonly { clientId: string; id: string; kind: string }[];
    gather?: () => Promise<GatheredApprovals>;
    sendFails?: string;
    sendConfigMissing?: boolean;
    settleThrows?: boolean;
  } = {}
): { deps: ApprovalNoticeDeps; sent: Sent[]; table: ReturnType<typeof makeTable>; gathers: number } {
  const table = over.table ?? makeTable();
  const sent: Sent[] = [];
  const counters = { gathers: 0 };

  const deps: ApprovalNoticeDeps = {
    async enabledKinds() {
      return new Set(over.enabled ?? [AS_KIND, LEAVE_KIND]);
    },
    async findRecipient() {
      return over.recipient === undefined ? RECIPIENT : over.recipient;
    },
    async gatherFor() {
      counters.gathers += 1;
      if (over.gather) return over.gather();
      // 🔵 일부러 한 번 쉰다 — 동시에 둘이 들어오는 시험에서 두 흐름이 실제로
      //    엇갈리게 하려면 await 지점이 있어야 한다.
      await Promise.resolve();
      return gathered(over.items ?? [ITEM_AS]);
    },
    sentKeysFor: (userId) => table.sentKeysFor(userId),
    claim: (params) => table.claim(params),
    async settle(params) {
      if (over.settleThrows) throw new Error("기록을 못 적었다");
      await table.settle(params);
    },
    async sendMail(params) {
      if (over.sendFails !== undefined) {
        return { ok: false, message: over.sendFails, configMissing: over.sendConfigMissing };
      }
      sent.push(params);
      return { ok: true };
    },
    inboxUrl: "https://portal.example.test/approvals",
  };

  return {
    deps,
    sent,
    table,
    get gathers() {
      return counters.gathers;
    },
  };
}

// ───────────────────────────────────────────── 보내는 쪽이 제대로 도는가

test("정상이면 메일 한 통이 나가고 기록이 `SENT` 로 남는다", async () => {
  const { deps, sent, table } = makeDeps();
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.mailed, true);
  assert.equal(report.itemsMailed, 1);
  assert.equal(report.skipped, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "approver1@example.test");

  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].status, "SENT");
});

test("🔴 켜 둔 갈래가 하나도 없으면 **아무 데도 묻지 않는다**", async () => {
  const made = makeDeps({ enabled: [] });
  const report = await runApprovalNoticeForUser(USER, made.deps);

  assert.equal(report.skipped, "no_enabled_kinds");
  assert.equal(report.mailed, false);
  // 🔴 이 줄이 본론이다. 기본값이 「전부 끔」이라 이것이 평범한 상태이고,
  //    여기서 안 끊으면 결재가 생길 때마다 사내 시스템 셋을 헛되이 두드린다.
  assert.equal(made.gathers, 0);
  assert.equal(made.sent.length, 0);
});

test("🔴 꺼진 갈래는 즉시 알림에서도 안 나간다", async () => {
  // A/S 검수만 켜고 휴가는 꺼 둔다.
  const { deps, sent, table } = makeDeps({
    enabled: [AS_KIND],
    items: [ITEM_AS, ITEM_LEAVE],
  });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.itemsMailed, 1, "꺼 둔 갈래까지 실렸다");
  assert.equal(report.skippedDisabled, 1);
  assert.equal(sent.length, 1);
  // 🔴 본문에 휴가 갈래 이름이 없어야 한다.
  assert.match(sent[0].text, /접수건 검수 결재 1건/);
  assert.equal(/휴가 신청 결재/.test(sent[0].text), false);
  // 🔴 꺼 둔 건은 **기록에도 안 남는다** — 나중에 켜면 그때 나가야 한다.
  assert.deepEqual(
    table.rows.map((row) => row.itemId),
    [ITEM_AS.id]
  );
});

test("🔴 메일 본문에 **저쪽 자료가 한 글자도** 없다", async () => {
  const { deps, sent } = makeDeps({ items: [ITEM_AS, ITEM_LEAVE] });
  await runApprovalNoticeForUser(USER, deps);

  assert.equal(sent.length, 1);
  // 표본이 비지 않았는지 먼저 본다 — 본문이 실제로 지어졌는가.
  assert.match(sent[0].text, /결재할 건이 2건 있습니다/);

  // 🔴 결재건 id 는 업무 식별자다(접수번호·휴가 신청 번호). 본문에 없어야 한다.
  for (const item of [ITEM_AS, ITEM_LEAVE]) {
    assert.equal(sent[0].text.includes(item.id), false, item.id);
  }
  // 🔴 제목에는 숫자도 안 들어간다 — 잠금 화면 미리보기에 뜬다.
  assert.equal(sent[0].subject, "[DSS] 결재할 건이 있습니다");
});

// ───────────────────────────────────────────── ① 즉시 알림이 두 번

test("🔴 같은 결재로 두 번 찔러도 메일은 **한 통**이다", async () => {
  const { deps, sent } = makeDeps();

  const first = await runApprovalNoticeForUser(USER, deps);
  const second = await runApprovalNoticeForUser(USER, deps);

  assert.equal(first.mailed, true);
  assert.equal(second.mailed, false);
  assert.equal(second.skipped, "nothing_to_send");
  assert.equal(second.skippedAlreadySent, 1);
  assert.equal(sent.length, 1, `메일이 ${sent.length}통 나갔다`);
});

// ───────────────────────────────────────────── ② 즉시 알림 + 주기 작업

test("🔴 즉시 알림이 보낸 건은 **주기 작업이 다시 보내지 않는다**", async () => {
  const { deps, sent, table } = makeDeps();
  await runApprovalNoticeForUser(USER, deps);
  assert.equal(sent.length, 1);

  // 주기 작업이 지금 돌면 무엇을 보낼 것인가 — 같은 표, 같은 고르기다.
  const wouldSend = await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND]));
  assert.deepEqual(wouldSend, []);
});

test("🔴 **보내는 중**인 건도 주기 작업이 집지 않는다 — 수명 안에서는", async () => {
  // 찍기까지만 하고 메일 서버에서 붙들린 상태를 흉내 낸다.
  const table = makeTable();
  await table.claim({
    userId: USER,
    rows: [{ clientId: ITEM_AS.clientId, itemId: ITEM_AS.id, kind: ITEM_AS.kind }],
  });

  const stillSending = await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND]));
  assert.deepEqual(stillSending, [], "보내는 중인 건을 주기 작업이 집었다 — 메일이 두 통 간다");

  // 🔴 그런데 수명이 지나면 집어야 한다. 안 그러면 찍어 놓고 죽은 줄이 영영
  //    안 나가고 **아무도 신고하지 않는다.**
  table.advance(APPROVAL_SENDING_LEASE_MS + 1);
  const afterLease = await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND]));
  assert.equal(afterLease.length, 1, "찍어 놓고 죽은 줄을 주기 작업이 영영 못 집는다");
});

// ───────────────────────────────────────────── ③ 동시에 둘

test("🔴 **동시에 둘이 들어와도 메일은 한 통**이다", async () => {
  const { deps, sent } = makeDeps();

  // 🔴 `Promise.all` 이다. 둘 다 gatherFor 의 await 에서 한 번 쉬므로, 「이미
  //    보냈나」 조회는 **둘 다 비어 있는 상태**에서 돈다 — 조회만으로 막는
  //    구현이라면 여기서 두 통이 나간다.
  const [a, b] = await Promise.all([
    runApprovalNoticeForUser(USER, deps),
    runApprovalNoticeForUser(USER, deps),
  ]);

  assert.equal(sent.length, 1, `메일이 ${sent.length}통 나갔다 — 겹침을 못 막았다`);
  // 하나는 보냈고 하나는 뺏겼다. 어느 쪽이 이겼는지는 정해져 있지 않다.
  assert.deepEqual([a.mailed, b.mailed].sort(), [false, true]);
  const loser = a.mailed ? b : a;
  assert.equal(loser.skipped, "already_claimed");
  assert.equal(loser.skippedLostRace, 1);
});

test("🔴 동시에 들어온 둘이 **다른 건**이면 둘 다 나간다", async () => {
  // 겹침 막기가 지나쳐서 「다른 건까지 막는」 쪽으로 틀어지면 안 된다.
  const table = makeTable();
  const first = makeDeps({ table, items: [ITEM_AS] });
  const second = makeDeps({ table, items: [ITEM_LEAVE] });

  await Promise.all([
    runApprovalNoticeForUser(USER, first.deps),
    runApprovalNoticeForUser(USER, second.deps),
  ]);

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1);
  assert.equal(table.rows.length, 2);
});

test("이미 보내는 중인 건은 **찍기 전에** 걸러진다 — 왕복 한 번을 아낀다", async () => {
  const table = makeTable();
  // 휴가 건은 다른 요청이 이미 찍어 갔다.
  await table.claim({
    userId: USER,
    rows: [{ clientId: ITEM_LEAVE.clientId, itemId: ITEM_LEAVE.id, kind: ITEM_LEAVE.kind }],
  });

  const { deps, sent } = makeDeps({ table, items: [ITEM_AS, ITEM_LEAVE] });
  const report = await runApprovalNoticeForUser(USER, deps);

  // 🔵 「이미 보냄」으로 빠진다 — 뺏긴 것(`skippedLostRace`)이 아니다. 둘은 다른
  //    자리에서 걸리고, 수가 어느 칸에 담기는지가 곧 **어디서 막혔나**를 말한다.
  assert.equal(report.skippedAlreadySent, 1);
  assert.equal(report.skippedLostRace, 0);
  assert.equal(report.itemsMailed, 1);
  assert.match(sent[0].text, /결재할 건이 1건 있습니다/);
});

test("🔴 **조회 뒤·찍기 전**에 뺏긴 건은 본문 건수에도 안 들어간다", async () => {
  // 🔴 이 틈이 겹침의 본체다. 위 시험의 거름망(`sentKeysFor`)은 이 틈을 못 막는다
  //    — 막는 것은 찍기 한 문장뿐이고, 여기서 그 한 문장만 재려고 틈을 흉내 낸다.
  const table = makeTable();
  const made = makeDeps({ table, items: [ITEM_AS, ITEM_LEAVE] });
  const claimAsUsual = made.deps.claim;
  made.deps.claim = async (params) => {
    // 바로 이 순간 다른 요청이 휴가 건을 먼저 찍는다.
    await table.claim({
      userId: USER,
      rows: [{ clientId: ITEM_LEAVE.clientId, itemId: ITEM_LEAVE.id, kind: ITEM_LEAVE.kind }],
    });
    return claimAsUsual(params);
  };

  const report = await runApprovalNoticeForUser(USER, made.deps);

  assert.equal(report.skippedLostRace, 1);
  assert.equal(report.itemsMailed, 1);
  // 🔴 「2건 있습니다」로 적히면 승인함에서 보이는 수와 다르다.
  assert.match(made.sent[0].text, /결재할 건이 1건 있습니다/);
  assert.equal(/휴가 신청 결재/.test(made.sent[0].text), false);
});

// ───────────────────────────────────────────── 보내기가 실패했을 때

test("🔴 보내기가 실패하면 기록을 **거두고**, 주기 작업이 다시 집는다", async () => {
  const { deps, table } = makeDeps({ sendFails: "SMTP 연결 실패" });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.mailed, false);
  assert.equal(report.skipped, "send_failed");
  assert.equal(report.sendError, "SMTP 연결 실패");

  // 🔴 「보냈음」으로 남으면 그 결재는 영영 안 나간다.
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].status, "FAILED");
  assert.equal(table.rows[0].error, "SMTP 연결 실패");

  // 🔴 그리고 **지금 당장** 주기 작업이 집어야 한다(수명을 기다리지 않는다).
  const wouldSend = await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND]));
  assert.equal(wouldSend.length, 1, "실패한 건을 주기 작업이 못 집는다");
});

test("실패한 건은 **다음 즉시 알림**에서도 다시 간다", async () => {
  const table = makeTable();
  const failing = makeDeps({ table, sendFails: "SMTP 연결 실패" });
  await runApprovalNoticeForUser(USER, failing.deps);

  const working = makeDeps({ table });
  const report = await runApprovalNoticeForUser(USER, working.deps);

  assert.equal(report.mailed, true);
  assert.equal(working.sent.length, 1);
  assert.equal(table.rows[0].status, "SENT");
});

test("메일 설정 자체가 없으면 그 까닭을 따로 적는다", async () => {
  const { deps, table } = makeDeps({ sendFails: "메일 설정이 없습니다", sendConfigMissing: true });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.skipped, "mail_config_missing");
  // 🔵 그래도 기록은 거둬진다 — 설정을 적은 뒤 주기 작업이 집어야 한다.
  assert.equal(table.rows[0].status, "FAILED");
});

test("🔴 거두기마저 실패하면 **수명이 지난 뒤** 주기 작업이 집는다", async () => {
  const table = makeTable();
  const { deps } = makeDeps({ table, sendFails: "SMTP 연결 실패", settleThrows: true });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.settleFailed, true);
  assert.equal(table.rows[0].status, APPROVAL_DELIVERY_SENDING);

  // 수명 안에서는 아무도 못 집는다(그 사이에 또 보내면 두 통이 된다).
  assert.deepEqual(await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND])), []);

  // 🔴 그러나 영영 묻히지는 않는다.
  table.advance(APPROVAL_SENDING_LEASE_MS + 1);
  assert.equal(
    (await table.whatThePeriodicJobWouldSend(USER, [ITEM_AS], new Set([AS_KIND]))).length,
    1
  );
});

// ───────────────────────────────────────────── 사람이 빠질 때 · 시스템이 죽을 때

test("포털에 없거나 ACTIVE 가 아닌 사람에게는 아무것도 안 한다", async () => {
  const made = makeDeps({ recipient: null });
  const report = await runApprovalNoticeForUser(USER, made.deps);

  assert.equal(report.skipped, "unknown_user");
  assert.equal(made.gathers, 0);
  assert.equal(made.sent.length, 0);
});

test("🔴 메일 주소가 없는 사람은 **조용히 빠지지 않는다**", async () => {
  const made = makeDeps({ recipient: { ...RECIPIENT, email: null } });
  const report = await runApprovalNoticeForUser(USER, made.deps);

  assert.equal(report.skipped, "no_email");
  assert.equal(made.sent.length, 0);
});

test("한 시스템을 못 물어봐도 **나머지는 보낸다** — 그리고 그 사실이 기록에 남는다", async () => {
  const { deps, sent, table } = makeDeps({
    gather: async () => ({
      items: [ITEM_AS],
      outcomes: [
        { clientId: "rf-service-system", status: "ok", count: 1 },
        { clientId: "dss-leave", status: "failed", reason: "TimeoutError" },
      ],
      degraded: true,
    }),
  });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.mailed, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(report.failedSources, [{ clientId: "dss-leave", reason: "TimeoutError" }]);
  // 🔵 못 물어본 시스템의 건은 기록에도 안 남는다 — 살아나면 그때 함께 간다.
  assert.deepEqual(
    table.rows.map((row) => row.clientId),
    ["rf-service-system"]
  );
});

test("저쪽이 「답할 수 없다」고 한 사정은 **고장과 다르게** 센다", async () => {
  const { deps } = makeDeps({
    gather: async () => ({
      items: [],
      outcomes: [{ clientId: "dss-leave", status: "unavailable", reason: "employee_not_linked" }],
      degraded: false,
    }),
  });
  const report = await runApprovalNoticeForUser(USER, deps);

  assert.deepEqual(report.unavailableSources, [
    { clientId: "dss-leave", reason: "employee_not_linked" },
  ]);
  assert.deepEqual(report.failedSources, []);
  assert.equal(report.skipped, "nothing_to_send");
});

test("🔴 도중에 깨져도 **던지지 않는다** — 응답 뒤에 도는 일이다", async () => {
  const { deps } = makeDeps({
    gather: async () => {
      throw new Error("토큰 서명이 깨졌다");
    },
  });

  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.skipped, "error");
  assert.equal(report.error, "토큰 서명이 깨졌다");
  assert.equal(report.mailed, false);
});

test("🔴 보낸 기록을 읽지 못하면 **보내지 않는다** — 모두에게 다시 보내는 것보다 낫다", async () => {
  const { deps, sent } = makeDeps();
  deps.sentKeysFor = async () => {
    throw new Error("DB 가 죽었다");
  };

  const report = await runApprovalNoticeForUser(USER, deps);

  assert.equal(report.skipped, "error");
  assert.equal(sent.length, 0);
});
