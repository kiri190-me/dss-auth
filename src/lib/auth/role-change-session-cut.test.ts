import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  cutSessionsForRevokedGrant,
  decideSessionCut,
  roleChangeNotice,
  type GrantRevocationDeps,
  type RevokedClient,
  type SessionCutAudit,
} from "./grant-revocation";

/**
 * ============================================================================
 * **역할을 바꾸면 그 즉시 반영되는가** — 끊는 자리·끊는 범위·못 끊었을 때의 말
 * ============================================================================
 * 받는 세 시스템(A/S·재고관리·휴가)은 **로그인할 때만** 포털이 보낸 역할을 제
 * users.role 에 받아 적는다. 그래서 포털에서 역할을 내려도 이미 들어가 있는
 * 사람은 옛 권한을 계속 썼고, 드롭다운을 바꾼 관리자는 막았다고 믿었다.
 * 🔴 **강등이 그렇게 새고 있었다.**
 *
 * 고치는 수단은 이미 깔려 있던 백채널 로그아웃이다. 그 집 하나에 보내면 그
 * 사람은 다음 요청에서 재로그인으로 떨어지고, 재로그인이 최신 역할을 반영한다.
 *
 * 이 파일이 지키는 것은 넷이다. 넷 다 "오류 없이 조용히 틀리는" 종류라 값이나
 * 자리로 못 박는다:
 *   1. 역할을 바꾸면 끊는다 — **승격도 강등도.**
 *   2. 끊는 곳은 **그 집 하나**다.
 *   3. 🔴 전 직원 공개 시스템에서도 끊는다 — 휴가(dss-leave)가 바로 그 집이고,
 *      회수 쪽 판정(NO_GRANT_CHECK)을 그대로 썼다면 **여기만 조용히 안 먹는다.**
 *   4. 못 끊어도 역할 변경은 저장되고, 못 끊었다는 사실을 사람에게 말한다.
 * ============================================================================
 */

const ACTION = "src/lib/server/actions/admin-access.ts";
const SCREEN = "src/app/admin/users/page.tsx";

/** 권한 확인을 하는 집. 역할도 쓴다. */
const AS: RevokedClient = {
  clientId: "rf-service-system",
  requiresGrant: true,
  isActive: true,
  backchannelLogoutUri: "http://as.test/api/auth/sso/backchannel-logout",
};

/**
 * 🔴 **전 직원 공개인데 역할을 쓰는 집.** 가짜 조합이 아니라 개발 DB 실측이다
 * (client-access-values.test.ts 의 다섯 시스템 목록, 2026-09-22) — 휴가는
 * requires_grant 가 false 이면서 MEMBER·LEAVE_ADMIN 을 쓴다. 역할은 전 직원
 * 공개 시스템에서도 부여 행에서 나오므로(getClientRole 은 requiresGrant 를
 * 보지 않는다) 여기서도 역할 변경은 끊어야 반영된다.
 */
const LEAVE: RevokedClient = {
  clientId: "dss-leave",
  requiresGrant: false,
  isActive: true,
  backchannelLogoutUri: "http://leave.test/api/auth/sso/backchannel-logout",
};

const TARGET = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "홍길동",
  actorUserId: "99999999-9999-4999-8999-999999999999",
  grantRecordId: "22222222-2222-4222-8222-222222222222",
  cause: "ROLE_CHANGED" as const,
};

type NotifyCall = { userId: string; clientId: string; logoutUri: string };

function spy(result: boolean | Error = true) {
  const notified: NotifyCall[] = [];
  const audited: SessionCutAudit[] = [];
  const deps: GrantRevocationDeps = {
    async notifyLogout(params) {
      notified.push(params);
      if (result instanceof Error) throw result;
      return result;
    },
    async audit(entry) {
      audited.push(entry);
    },
  };
  return { deps, notified, audited };
}

/**
 * 주석을 걷어낸 본문.
 *
 * 🔴 소스 글자로 재는 검사는 주석까지 센다. 이 파일은 "화면에서 그 말이
 * 사라졌는가"를 묻는데, 바로 그 말이 **왜 사라졌는지를 적은 주석**이 코드 옆에
 * 남아 있다. 걷어내지 않으면 그 주석 때문에 영영 실패한다(반대로 "있어야
 * 한다" 쪽은 주석만으로 영영 통과한다).
 */
function visibleSource(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX 주석
    .replace(/\/\*[\s\S]*?\*\//g, "") // 블록 주석
    .replace(/^[ \t]*\/\/.*$/gm, ""); // 줄 주석
}

// ───── 1. 역할을 바꾸면 끊는다 ─────

test("🔴 역할을 바꾸면 그 시스템의 세션을 끊는다", async () => {
  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: false });
  assert.deepEqual(
    notified.map((call) => [call.userId, call.clientId]),
    [[TARGET.userId, "rf-service-system"]]
  );
});

test("🔴 판정은 역할이 무엇으로 바뀌었는지를 아예 묻지 않는다 — 승격도 강등도 같다", () => {
  // decideSessionCut 의 인자에 역할이 없다는 것이 곧 "방향을 가르지 않는다"이다.
  // 값으로 한 번 더 확인한다: 같은 집·같은 까닭이면 결과가 하나뿐이다.
  assert.equal(decideSessionCut(AS, "ROLE_CHANGED"), null);
  assert.equal(decideSessionCut(LEAVE, "ROLE_CHANGED"), null);
});

test("🔴 역할 변경 갈래에 방향을 가르는 조건이 없다 — 올려도 끊는다", () => {
  const source = readFileSync(ACTION, "utf8");
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");
  const grant = source.indexOf("// ───── 새로 부여 ─────");
  assert.ok(roleChange > 0 && grant > roleChange, "갈래 구분 주석이 사라졌다");

  const branch = source.slice(roleChange, grant);
  const update = branch.indexOf(".update(userClientGrants)");
  const call = branch.indexOf("cutSessionsForRevokedGrant(");
  assert.ok(update > 0, "역할을 저장하는 자리가 사라졌다");
  // 🔴 저장 **뒤에** 끊는다. 뒤집으면 통보와 저장 사이에 그 사람이 다시
  // 로그인해 옛 역할로 세션을 새로 만든다.
  assert.ok(call > update, "역할을 저장하기 전에 세션을 끊고 있다");

  // 저장과 끊기 사이에 조건이 끼면 "어떤 때는 안 끊는다"가 된다. 승격/강등을
  // 가르는 규칙이 몰래 생기는 자리가 바로 여기다.
  assert.ok(
    !branch.slice(update, call).includes("if ("),
    "🔴 역할을 저장한 뒤 세션을 끊기까지 조건이 생겼다 — 방향을 가르고 있을 수 있다"
  );
});

test("🔴 끊는 까닭을 ROLE_CHANGED 로 적는다 — 감사 기록에서 회수와 구분된다", async () => {
  const { deps, audited } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.equal(audited.length, 1);
  assert.equal(audited[0].actionType, "SESSION_REVOKED");
  assert.equal(audited[0].newValue.reason, "ROLE_CHANGED");
  assert.equal(audited[0].newValue.userId, TARGET.userId);
  assert.equal(audited[0].newValue.cut, true);
});

test("🔴 역할 변경 갈래가 그 까닭을 넘긴다 — 기본값으로 회수 판정을 물려받지 않는다", () => {
  const source = readFileSync(ACTION, "utf8");
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");
  const grant = source.indexOf("// ───── 새로 부여 ─────");
  const branch = source.slice(roleChange, grant);

  assert.ok(branch.includes('cause: "ROLE_CHANGED"'), "까닭을 넘기지 않는다");
  assert.ok(!branch.includes('cause: "ACCESS_REVOKED"'), "회수 까닭으로 적고 있다");
});

// ───── 2. 끊는 곳은 그 집 하나 ─────

test("🔴 역할을 바꾼 그 집 하나에만 보낸다 — 다른 집에서 하던 일은 안 끊긴다", async () => {
  const { deps, notified } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: LEAVE }, deps);

  // 표본이 비어서 공짜로 통과하지 않도록, 보낸 것이 하나 **있다**는 것부터 센다.
  assert.equal(notified.length, 1, "아무 데도 안 보냈다");
  assert.deepEqual(
    notified.map((call) => call.clientId),
    ["dss-leave"]
  );
  assert.notEqual(notified[0].clientId, "rf-service-system");
  assert.notEqual(notified[0].userId, TARGET.actorUserId);
});

test("🔴 역할은 집마다 독립이라, 한 집이 꺼져 있어도 다른 집 반영을 막지 않는다", async () => {
  // 위임 전파(B-13)는 셋이 다 성공해야 적는다. 역할은 그러면 안 된다 —
  // 여기서는 실패해도 outcome 하나로 끝나고, 다른 집은 애초에 부르지도 않는다.
  const { deps, notified } = spy(new Error("휴가가 꺼져 있다"));
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: LEAVE }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: true });
  assert.equal(notified.length, 1);
});

// ───── 3. 전 직원 공개 시스템 ─────

test("🔴 전 직원 공개 시스템이어도 역할 변경은 끊는다 — 휴가가 바로 그 집이다", async () => {
  // 🔴 회수 쪽 판정을 그대로 썼다면 여기서 NO_GRANT_CHECK 로 건너뛰고,
  // 휴가의 역할 강등만 조용히 안 먹는다. 사용자가 본 어긋남이 바로 그 집이다.
  assert.equal(decideSessionCut(LEAVE, "ROLE_CHANGED"), null);

  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: LEAVE }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: false });
  assert.equal(notified.length, 1);
  assert.equal(notified[0].logoutUri, LEAVE.backchannelLogoutUri);
});

test("회수는 전 직원 공개 시스템에서 지금처럼 건너뛴다 — 까닭만 갈린다", () => {
  // 같은 집·같은 칸인데 까닭이 다르면 판정이 갈린다는 것을 나란히 둔다.
  assert.equal(decideSessionCut(LEAVE, "ACCESS_REVOKED"), "NO_GRANT_CHECK");
  assert.equal(decideSessionCut(LEAVE, "ROLE_CHANGED"), null);
});

test("역할 변경도 비활성 시스템과 통보 주소 없음은 건너뛴다", () => {
  // 이 둘은 까닭과 무관하다 — 보낼 곳이 없거나, 포털 전체가 없는 것으로 다루는 집이다.
  assert.equal(decideSessionCut({ ...AS, isActive: false }, "ROLE_CHANGED"), "CLIENT_INACTIVE");
  assert.equal(
    decideSessionCut({ ...AS, backchannelLogoutUri: null }, "ROLE_CHANGED"),
    "NO_BACKCHANNEL_URI"
  );
});

// ───── 4. 못 끊었을 때 ─────

test("🔴 못 끊어도 역할 변경은 되돌리지 않는다 — 던지지 않고 결과만 들고 온다", async () => {
  const { deps } = spy(new Error("A/S 가 꺼져 있다"));
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);
  assert.equal(outcome.failed, true);
});

test("🔴 못 끊었으면 사람에게 말한다 — 조용히 넘기지 않는다", () => {
  const failed = roleChangeNotice({ cut: true, skipped: null, failed: true });
  assert.match(failed, /통보하지 못했습니다/);
  assert.match(failed, /다음 로그인부터 반영됩니다/);

  const noUri = roleChangeNotice({
    cut: false,
    skipped: "NO_BACKCHANNEL_URI",
    failed: false,
  });
  assert.match(noUri, /통보 주소가 없어/);
  assert.match(noUri, /다음 로그인부터 반영됩니다/);

  const inactive = roleChangeNotice({
    cut: false,
    skipped: "CLIENT_INACTIVE",
    failed: false,
  });
  assert.match(inactive, /비활성 시스템/);
  assert.match(inactive, /다음 로그인부터 반영됩니다/);
});

test("🔴 끊었을 때는 「다음 로그인부터」라고 말하지 않는다 — 그게 이 조각의 요지다", () => {
  const notice = roleChangeNotice({ cut: true, skipped: null, failed: false });
  assert.match(notice, /세션도 끊었습니다/);
  assert.match(notice, /새 역할/);
  assert.ok(
    !notice.includes("다음 로그인부터 반영됩니다"),
    "끊어 놓고 다음 로그인부터라고 말하고 있다"
  );
});

test("역할 변경 갈래가 그 뒷말을 실제로 쓴다 — 결과를 들고만 있으면 아무도 못 본다", () => {
  const source = readFileSync(ACTION, "utf8");
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");
  const grant = source.indexOf("// ───── 새로 부여 ─────");
  const branch = source.slice(roleChange, grant);

  assert.ok(branch.includes("roleChangeNotice(outcome)"), "결과를 화면에 알리지 않는다");
  // 🔴 통보 실패로 역할 변경을 거절하면 관리자가 "바꿨는데 안 바뀌었다"를 겪는다.
  const call = branch.indexOf("cutSessionsForRevokedGrant(");
  assert.ok(!branch.slice(call).includes("fail("), "못 끊었다고 역할 변경을 되돌리고 있다");
});

// ───── 화면 안내 글 ─────

test("🔴 화면이 더 이상 「다음 로그인부터 반영됩니다」라고만 말하지 않는다", () => {
  const source = visibleSource(SCREEN);

  // 표본이 비어서 공짜로 통과하지 않게, 무엇을 재는지부터 단언한다.
  assert.ok(source.includes("시스템 접근·역할"), "볼 칸을 못 찾았다 — 표본이 비었다");

  assert.ok(
    !source.includes("다음 로그인부터 반영됩니다"),
    "🔴 이제 바로 반영되는데 화면은 다음 로그인부터라고 말하고 있다"
  );
  assert.ok(source.includes("역할을 바꾸면 바로 반영됩니다"), "바뀐 사실을 안내하지 않는다");
});

test("🔴 주석의 수동 우회 안내가 사라졌다 — 이제 그럴 필요가 없다", () => {
  const source = readFileSync(ACTION, "utf8");

  // 전에는 "급하면 권한을 회수해 세션을 끊고 다시 낮은 역할로 주라"고 적혀 있었다.
  // 그 말이 남아 있으면 읽는 사람이 멀쩡한 기능을 두고 두 번 일한다.
  assert.ok(
    !source.includes("다시 낮은 역할로 주는 것이 지금의 수단이다"),
    "수동 우회 안내가 남아 있다"
  );

  // 🔴 "끊지 않는다"는 말 자체는 **「새로 부여」 갈래에 아직 맞는 말로 남아
  // 있다.** 그래서 파일 전체가 아니라 역할 변경 칸만 본다 — 전체로 재면
  // 멀쩡한 주석 때문에 영영 실패하고, 다음 사람이 그 주석을 지운다.
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");
  const grant = source.indexOf("// ───── 새로 부여 ─────");
  assert.ok(roleChange > 0 && grant > roleChange, "갈래 구분 주석이 사라졌다");
  assert.ok(
    !source.slice(roleChange, grant).includes("세션을 끊지 않는다"),
    "역할 변경 칸에 안 끊는다는 주석이 남아 있다"
  );
});
