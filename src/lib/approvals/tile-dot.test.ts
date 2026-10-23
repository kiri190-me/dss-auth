import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  APPROVALS_TILE_CLIENT_ID,
  APPROVAL_TILE_DOT_BUDGET_MS,
  decideApprovalTileDot,
  hasNewApprovals,
  isApprovalsTile,
} from "./tile-dot";

/**
 * ============================================================================
 * 빨간 점의 값어치는 **거짓말을 안 하는 것** 하나다
 * ============================================================================
 * 사용자 요구는 셋이었다(2026-10-23): 새 결재가 오면 뜬다 · 승인함에 들어가면
 * 사라진다 · 해소되면 사라진다. 아래 시험은 그 셋을 못 박고, 거기에 이 저장소가
 * 더 무겁게 보는 넷을 더한다 —
 *
 *   🔴 한 번도 안 연 사람에게도 뜬다(가장 알려야 할 사람이다)
 *   🔴 **못 쟀으면 안 뜬다**(DB 를 못 읽었을 때 · 시스템이 죽었을 때 · 상한)
 *   🔴 재는 길이 늦어도 화면을 붙들지 않는다
 *   🔴 **승인함 말고 다른 타일에는 안 뜬다**
 *
 * 🔴 값은 전부 가짜다 — 사람 이름도 메일 주소도 들어 있지 않다.
 * ============================================================================
 */

/** 실패 갈래는 서버 로그에 한 줄씩 남긴다 — 시험 출력만 조용히 한다. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

const SEEN = new Date("2026-10-23T09:00:00.000Z");
const BEFORE = { requestedAt: "2026-10-23T08:59:59.000Z" };
const AFTER = { requestedAt: "2026-10-23T09:00:01.000Z" };

// ───────────────────────────────────────── 요구 셋

test("🔴 마지막으로 연 뒤에 올라온 결재가 있으면 점이 뜬다", () => {
  assert.equal(hasNewApprovals([BEFORE, AFTER], SEEN), true);
});

test("🔴 승인함을 열면 점이 사라진다 — 남은 건이 전부 그 전의 것이 되므로", () => {
  // 「열었다」가 하는 일은 seen_at 을 지금으로 미는 것뿐이다(screen-request.ts).
  // 그 한 줄로 아래가 뒤집히는지를 여기서 잰다.
  const items = [BEFORE, AFTER];
  assert.equal(hasNewApprovals(items, SEEN), true, "열기 전");

  const opened = new Date("2026-10-23T09:00:02.000Z");
  assert.equal(hasNewApprovals(items, opened), false, "열고 난 뒤");
});

test("🔴 결재가 해소되면 점이 사라진다 — seen_at 을 갱신하지 않아도", () => {
  // 요구 ③. 해소된 건은 그 시스템의 목록에서 빠지므로 셀 것이 없어진다.
  // 🔵 **같은 seen_at** 을 그대로 쓴다 — 갱신 없이 꺼지는 것이 요점이다.
  assert.equal(hasNewApprovals([AFTER], SEEN), true, "표본이 비면 아래가 공짜로 통과한다");
  assert.equal(hasNewApprovals([], SEEN), false);
});

// ───────────────────────────────────────── 한 번도 안 연 사람

test("🔴 한 번도 안 연 사람에게는 결재가 있으면 점이 뜬다", () => {
  // 이 사람에게는 모든 결재가 「아직 안 본 것」이다. 여기서 안 띄우면 승인함을
  // 한 번도 안 연 사람은 **영영 점을 못 본다** — 가장 알려야 할 사람이다.
  assert.equal(hasNewApprovals([BEFORE], null), true);
});

test("한 번도 안 열었어도 결재가 없으면 점은 없다", () => {
  assert.equal(hasNewApprovals([], null), false);
});

// ───────────────────────────────────────── 모르겠으면 끈다

test("🔴 같은 시각(동률)은 새것이 아니다 — 그때 화면에 함께 떠 있었다", () => {
  assert.equal(hasNewApprovals([{ requestedAt: SEEN.toISOString() }], SEEN), false);
});

test("🔴 읽을 수 없는 requestedAt 은 세지 않는다 — 셌다면 점이 영영 안 꺼진다", () => {
  // 저쪽이 그 칸을 빼먹으면 빈 글자로 올라온다(screen-inbox.ts 가 줄을 안 버린다).
  // 그 줄을 「새것」으로 치면 승인함을 열어도 견줄 값이 없어 점이 안 꺼진다.
  for (const broken of ["", "   ", "어제", "2026-13-45T99:99:99Z"]) {
    assert.equal(hasNewApprovals([{ requestedAt: broken }], SEEN), false, broken);
  }
  // 🔵 성한 줄이 섞여 있으면 그 줄로 켜진다 — 깨진 줄 하나가 나머지를 가리지 않는다.
  assert.equal(hasNewApprovals([{ requestedAt: "" }, AFTER], SEEN), true);
});

test("seen_at 이 Invalid Date 면 점을 띄우지 않는다 — 기준이 없다", () => {
  assert.equal(hasNewApprovals([AFTER], new Date("깨진 값")), false);
});

// ───────────────────────────────────────── 어느 타일인가

test("🔴 점은 승인함 타일에만 붙는다 — 나머지 여덟은 그대로다", () => {
  assert.equal(isApprovalsTile(APPROVALS_TILE_CLIENT_ID), true);
  const others = [
    "rf-service-system",
    "dss-inventory",
    "dss-leave",
    "dss-improvements",
    "dss-board",
    "dss-rf-trouble",
    "dss-home",
    "dss-po",
  ];
  assert.equal(others.length, 8, "표본이 비면 아래 단언이 공짜로 통과한다");
  for (const clientId of others) {
    assert.equal(isApprovalsTile(clientId), false, clientId);
  }
});

test("승인함의 열쇠는 clients.client_id 다 — 저쪽 env.ts 와 같은 글자", () => {
  // 🔴 저장소 이름과 다른 열쇠가 이미 있다(알림 종의 `dss-rf-trouble`). 글자가
  //    어긋나면 오류 없이 **점만 영영 안 뜬다.**
  assert.equal(APPROVALS_TILE_CLIENT_ID, "dss-approvals");
});

// ───────────────────────────────────────── 재는 일 한 번

type Calls = { seen: number; approvals: number };

function deps(
  over: {
    seenAt?: Date | null;
    seenFails?: boolean;
    items?: { requestedAt: string }[];
    approvalsFails?: boolean;
    approvalsHang?: boolean;
    budgetMs?: number;
  },
  calls: Calls = { seen: 0, approvals: 0 }
) {
  return {
    calls,
    deps: {
      budgetMs: over.budgetMs,
      readSeenAt: async () => {
        calls.seen += 1;
        if (over.seenFails) throw new Error("DB 가 답하지 않습니다");
        return over.seenAt ?? null;
      },
      readApprovals: async () => {
        calls.approvals += 1;
        if (over.approvalsFails) throw new Error("모으다 깨졌습니다");
        // 🔴 신호를 안 듣는 가짜다. 상한이 없으면 이 시험이 영영 안 끝난다 —
        //    그 사실 자체가 상한을 재는 방법이다.
        if (over.approvalsHang) return new Promise<never>(() => {});
        return { items: over.items ?? [] };
      },
    },
  };
}

test("🔴 재서 새 결재가 있으면 참, 없으면 거짓", async () => {
  const yes = deps({ seenAt: SEEN, items: [AFTER] });
  assert.equal(await decideApprovalTileDot(yes.deps), true);
  assert.deepEqual(yes.calls, { seen: 1, approvals: 1 }, "한 번씩만 묻는다");

  const no = deps({ seenAt: SEEN, items: [BEFORE] });
  assert.equal(await decideApprovalTileDot(no.deps), false);
});

test("🔴 seen_at 을 못 읽으면 점을 띄우지 않는다 — 그리고 세 시스템에 묻지도 않는다", async () => {
  // 🔴 **「한 번도 안 열었다」로 보면 안 된다.** 그렇게 다루면 DB 가 흔들리는
  //    동안 전 직원의 타일에 빨간 점이 뜨고, 들어가 보면 아무것도 없다.
  const { deps: d, calls } = deps({ seenFails: true, items: [AFTER] });
  assert.equal(await quiet(() => decideApprovalTileDot(d)), false);
  assert.equal(calls.approvals, 0, "못 잴 것이 뻔한데 사내 시스템 셋을 두드렸다");
});

test("🔴 시스템에 못 물어보면 점을 띄우지 않는다 — 던지지도 않는다", async () => {
  const { deps: d } = deps({ seenAt: SEEN, approvalsFails: true });
  assert.equal(await quiet(() => decideApprovalTileDot(d)), false);
});

test("🔴 상한을 넘기면 점 없이 돌아온다 — 화면을 붙들지 않는다", async () => {
  // 답이 영영 안 오는 시스템을 세워 둔다. 상한이 없으면 이 시험이 끝나지 않는다.
  const { deps: d } = deps({ seenAt: SEEN, approvalsHang: true, budgetMs: 20 });

  const started = Date.now();
  assert.equal(await quiet(() => decideApprovalTileDot(d)), false);
  // 넉넉히 잡는다 — 느린 기계에서 깜빡이는 시험이 되면 아무도 안 믿는다.
  assert.ok(Date.now() - started < 2_000, "상한을 안 지켰다");
});

test("상한은 2.5초다 — 안쪽 1.5초(세 시스템) 바깥의 한 겹", async () => {
  // 🔴 왕복에는 이미 상한이 있다(screen-gather.ts). 이 값이 덮는 것은 상한이
  //    없는 DB 조회 둘이다. 1.5초보다 **작게** 두면 정상인 날에도 점이 꺼진다.
  assert.equal(APPROVAL_TILE_DOT_BUDGET_MS, 2_500);
  assert.ok(APPROVAL_TILE_DOT_BUDGET_MS > 1_500);
});

// ───────────────────────────────────────── 화면에 무엇이 붙는가

/**
 * `/apps` 원본에서 **주석을 걷어 낸** 글자.
 *
 * 🔴 걷어 내지 않으면 아래 시험들이 **주석 때문에 통과한다.** 그 화면의 주석에는
 * 「새 결재」도 `isApprovalsTile` 도 적혀 있다(까닭을 적은 글이다). 재야 하는
 * 것은 **그리는 코드**다.
 */
function appsPageSource(): string {
  const raw = readFileSync(new URL("../../app/apps/page.tsx", import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("🔴 점 옆에 **읽을 수 있는 말**이 붙는다 — 색만으로 알리지 않는다", () => {
  const source = appsPageSource();
  assert.ok(source.includes("새 결재"), "글자가 없다 — 빨강을 못 가리면 알 길이 없다");
  assert.ok(
    source.includes('title="확인하지 않은 새 결재가 있습니다"'),
    "마우스를 얹었을 때의 한 문장이 없다"
  );
  // 점 자체는 장식이라 낭독기에서 빼고, 뜻은 글자가 나른다.
  assert.ok(source.includes('aria-hidden="true"'));
});

test("🔴 화면은 승인함 타일만 가려 그린다 — 그리고 시스템 이름을 적지 않는다", () => {
  const source = appsPageSource();
  assert.ok(source.includes("isApprovalsTile"), "어느 타일인지 가리지 않는다");
  // 🔴 UnreadDot 과 같은 규율이다. 이름이 화면에 박히면 바뀌는 날 두 곳을 고쳐야
  //    하고, 한 곳을 빠뜨리면 **오류 없이 점만 사라진다.**
  assert.equal(
    source.includes(APPROVALS_TILE_CLIENT_ID),
    false,
    "화면에 client_id 가 박혔다"
  );
});

test("🔴 점을 기다리느라 첫 화면이 늦지 않는다 — Suspense 로 흘려 넣는다", () => {
  const source = appsPageSource();
  assert.ok(source.includes("<NewApprovalBadge"), "표시를 그리지 않는다");
  assert.equal(
    /await\s+hasNewApprovalsForTile/.test(source),
    false,
    "약속을 기다리고 있다 — 타일이 남의 서버 사정만큼 늦어진다"
  );
  // 승인함 타일이 없는 사람에게는 세 시스템을 두드리지도 않는다.
  assert.ok(source.includes("tiles.some("), "타일이 없어도 묻고 있다");
});

test("🔴 재는 쪽이 받는 칸은 읽기 둘과 상한뿐이다 — 쓰는 함수가 낄 자리가 없다", () => {
  // 여기에 「열었다」를 적는 함수가 끼면 **`/apps` 를 여는 것만으로 점이 꺼져**
  // 점이 영영 안 뜬다. 칸을 하나 더하면 이 줄이 걸리고, 그 칸을 **필수**로
  // 더하면 위 가짜들이 컴파일에서 먼저 걸린다.
  // 🔵 배선까지 그런지(진짜로 쓰는 모듈에 닿지 않는지)는 mail-seen-fence.test.ts 가
  //    들머리부터 import 를 따라가며 잰다.
  const { deps: d } = deps({ seenAt: SEEN, items: [] });
  assert.deepEqual(Object.keys(d).sort(), ["budgetMs", "readApprovals", "readSeenAt"]);
});
