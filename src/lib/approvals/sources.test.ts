import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientTile } from "@/lib/db/queries/clients";
import { APPROVAL_MAIL_KINDS } from "./kinds";
import {
  APPROVAL_SOURCE_CLIENT_IDS,
  APPROVAL_SOURCE_PATH,
  DELEGATION_PUSH_PATH,
  planDelegationPush,
  toApprovalSources,
} from "./sources";

/**
 * 「어디에 물을 것인가」.
 *
 * 🔴 이 파일이 지키는 것 둘: **들어갈 수 없는 시스템에는 묻지 않는다**(받은 타일만
 * 본다), **주소를 모르는 시스템은 조용히 빠지지 않는다**.
 */

function tile(clientId: string, launcherUrl: string | null): ClientTile {
  return {
    clientId,
    name: clientId,
    description: null,
    launcherUrl,
    launcherIcon: null,
  };
}

test("물어볼 시스템은 갈래 표에서 뽑힌다 — 목록을 두 벌 적지 않는다", () => {
  assert.deepEqual(APPROVAL_SOURCE_CLIENT_IDS, [
    "rf-service-system",
    "dss-inventory",
    "dss-leave",
  ]);
  // 🔴 뽑아낸 값이라는 사실 자체를 재 둔다. 손으로 적힌 목록으로 바뀌면 이 줄이
  //    깨진다 — 두 벌이 되는 날이 조용히 낡기 시작하는 날이다.
  for (const clientId of APPROVAL_SOURCE_CLIENT_IDS) {
    assert.ok(
      APPROVAL_MAIL_KINDS.some((entry) => entry.clientId === clientId),
      `${clientId} 이 갈래 표에 없다`
    );
  }
});

test("세 시스템이 같은 경로를 쓴다", () => {
  assert.equal(APPROVAL_SOURCE_PATH, "/api/integration/approvals");
});

test("타일 목록에서 결재 통로를 가진 시스템만 고른다", () => {
  const { sources, skipped } = toApprovalSources([
    tile("rf-service-system", "http://as.test:3000/"),
    // 결재 통로가 없는 시스템. 빠지는 것이 정상이고 skipped 에도 안 들어간다.
    tile("dss-board", "http://board.test:3400/"),
    tile("dss-leave", "http://leave.test:3700/leave"),
  ]);

  assert.deepEqual(skipped, []);
  assert.deepEqual(sources, [
    {
      clientId: "rf-service-system",
      name: "rf-service-system",
      approvalsUrl: "http://as.test:3000/api/integration/approvals",
    },
    {
      clientId: "dss-leave",
      name: "dss-leave",
      // 🔵 런처 주소의 **origin 만** 쓴다. 뒤에 붙은 경로는 버린다.
      approvalsUrl: "http://leave.test:3700/api/integration/approvals",
    },
  ]);
});

test("🔴 들어갈 수 없는 시스템은 애초에 목록에 없다 — 이 함수가 만들어 낼 수 없다", () => {
  // 타일을 못 받으면(권한이 없으면) 물어볼 곳도 없다. 권한 판정은 여기 없다.
  const { sources, skipped } = toApprovalSources([]);
  assert.deepEqual(sources, []);
  assert.deepEqual(skipped, []);
});

test("🔴 주소를 모르는 시스템은 조용히 빠지지 않고 까닭과 함께 돌아온다", () => {
  const { sources, skipped } = toApprovalSources([
    tile("rf-service-system", null),
    tile("dss-inventory", "주소아님"),
  ]);

  assert.deepEqual(sources, []);
  assert.deepEqual(skipped, [
    { clientId: "rf-service-system", reason: "no_launcher_url" },
    { clientId: "dss-inventory", reason: "bad_launcher_url" },
  ]);
});

/* ------------------------------------------------------------------ */
/* 써 주러 갈 곳 — 묻는 길과 **다르게** 센다                             */
/* ------------------------------------------------------------------ */

test("위임을 써 줄 경로도 셋이 같다", () => {
  assert.equal(DELEGATION_PUSH_PATH, "/api/integration/delegations");
});

test("🔴 전파는 묻는 길과 **같은 목록**을 쓴다 — 셋 전부에 간다", () => {
  const { targets, unreachable } = planDelegationPush([
    tile("rf-service-system", "http://as.test:3000/"),
    tile("dss-inventory", "http://inv.test:3800/parts"),
    tile("dss-leave", "http://leave.test:3700/"),
    // 결재가 없는 시스템. 전파할 것이 없으니 **실패도 아니다.**
    tile("dss-board", "http://board.test:3400/"),
  ]);

  assert.deepEqual(unreachable, []);
  assert.deepEqual(targets, [
    {
      clientId: "rf-service-system",
      name: "rf-service-system",
      delegationsUrl: "http://as.test:3000/api/integration/delegations",
    },
    {
      clientId: "dss-inventory",
      name: "dss-inventory",
      delegationsUrl: "http://inv.test:3800/api/integration/delegations",
    },
    {
      clientId: "dss-leave",
      name: "dss-leave",
      delegationsUrl: "http://leave.test:3700/api/integration/delegations",
    },
  ]);
  // 🔴 **셋을 다 세는가**를 한 줄로 못 박는다. 갈래가 늘어 목록이 넷이 되는 날
  //    이 줄이 깨지고, 그때 전파도 함께 늘어야 한다.
  assert.equal(targets.length, APPROVAL_SOURCE_CLIENT_IDS.length);
});

test("🔴 목록에 없는 시스템은 **빠지는 것이 아니라 실패**다 — 거기만 위임이 안 걸린다", () => {
  // 휴가가 `clients` 에 없거나 꺼져 있다. 묻는 길에서는 「그 사람이 못 들어가는
  // 시스템」이라 조용히 빠지지만, 전파에서는 드러나야 한다.
  const { targets, unreachable } = planDelegationPush([
    tile("rf-service-system", "http://as.test:3000/"),
    tile("dss-inventory", null),
  ]);

  assert.deepEqual(
    targets.map((target) => target.clientId),
    ["rf-service-system"]
  );
  assert.deepEqual(unreachable, [
    { clientId: "dss-inventory", reason: "no_launcher_url" },
    { clientId: "dss-leave", reason: "not_registered" },
  ]);
});

test("🔴 아무것도 못 읽었으면 셋 다 「갈 수 없음」이다 — 빈 목록이 성공으로 읽히면 안 된다", () => {
  const { targets, unreachable } = planDelegationPush([]);
  assert.deepEqual(targets, []);
  assert.deepEqual(
    unreachable.map((row) => row.reason),
    ["not_registered", "not_registered", "not_registered"]
  );
});
