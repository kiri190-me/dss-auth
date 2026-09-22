import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  cutSessionsForRevokedGrant,
  decideSessionCut,
  sessionCutNotice,
  type GrantRevocationDeps,
  type RevokedClient,
  type SessionCutAudit,
} from "./grant-revocation";

const AS: RevokedClient = {
  clientId: "rf-service-system",
  requiresGrant: true,
  isActive: true,
  backchannelLogoutUri: "http://as.test/api/auth/sso/backchannel-logout",
};

/** 전 직원 공개 시스템. 부여 행을 보지 않고 들여보낸다. */
const OPEN_TO_ALL: RevokedClient = { ...AS, clientId: "dss-home", requiresGrant: false };

const TARGET = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "홍길동",
  actorUserId: "99999999-9999-4999-8999-999999999999",
  grantRecordId: "22222222-2222-4222-8222-222222222222",
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

// ───── 판정 ─────

test("권한 확인을 하는 시스템이면 세션을 끊는다", () => {
  assert.equal(decideSessionCut(AS), null);
});

test("🔴 전 직원 공개 시스템은 끊지 않는다 — 회수해도 그 사람은 계속 들어간다", () => {
  assert.equal(decideSessionCut(OPEN_TO_ALL), "NO_GRANT_CHECK");
});

test("비활성 시스템에는 통보하지 않는다 — 포털의 다른 판정과 같은 취급이다", () => {
  assert.equal(decideSessionCut({ ...AS, isActive: false }), "CLIENT_INACTIVE");
});

test("통보 주소가 없으면 보낼 곳이 없다", () => {
  assert.equal(decideSessionCut({ ...AS, backchannelLogoutUri: null }), "NO_BACKCHANNEL_URI");
});

test("전 직원 공개가 통보 주소보다 먼저다 — 주소가 있어도 끊을 이유가 없다", () => {
  assert.equal(decideSessionCut({ ...OPEN_TO_ALL, isActive: false }), "NO_GRANT_CHECK");
});

// ───── 실제로 끊는가 ─────

test("🔴 권한을 회수하면 그 시스템에 로그아웃을 통보한다", async () => {
  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: false });
  assert.equal(notified.length, 1);
  assert.equal(notified[0].clientId, "rf-service-system");
  assert.equal(notified[0].logoutUri, AS.backchannelLogoutUri);
});

test("🔴 끊기는 사람은 권한을 빼앗긴 그 사람뿐이다", async () => {
  const { deps, notified } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  // 통보에 실리는 사람이 하나이고, 그것이 대상자다. 여기에 관리자나 다른
  // 사람의 id가 실리면 엉뚱한 사람이 로그아웃된다.
  assert.deepEqual(
    notified.map((call) => call.userId),
    [TARGET.userId]
  );
  assert.notEqual(notified[0].userId, TARGET.actorUserId);
});

test("🔴 통보는 그 시스템 하나에만 간다 — 다른 시스템에서 하던 일은 끊기지 않는다", async () => {
  const { deps, notified } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.deepEqual(
    notified.map((call) => call.clientId),
    ["rf-service-system"]
  );
});

test("🔴 전 직원 공개 시스템에는 통보를 보내지 않는다", async () => {
  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: OPEN_TO_ALL }, deps);

  assert.deepEqual(outcome, { cut: false, skipped: "NO_GRANT_CHECK", failed: false });
  assert.equal(notified.length, 0);
});

test("통보 주소가 없으면 아무것도 보내지 않는다", async () => {
  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant(
    { ...TARGET, client: { ...AS, backchannelLogoutUri: null } },
    deps
  );

  assert.deepEqual(outcome, { cut: false, skipped: "NO_BACKCHANNEL_URI", failed: false });
  assert.equal(notified.length, 0);
});

test("통보가 거절되면 실패로 남는다 — 그래도 던지지 않는다", async () => {
  const { deps, audited } = spy(false);
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: true });
  assert.equal(audited[0].newValue.backchannelFailed, true);
});

test("통보가 예외를 던져도 권한 회수는 끝난 것으로 둔다", async () => {
  const { deps, audited } = spy(new Error("A/S가 꺼져 있다"));
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: true });
  assert.equal(audited.length, 1);
});

test("감사 기록이 실패해도 던지지 않는다", async () => {
  const outcome = await cutSessionsForRevokedGrant(
    { ...TARGET, client: AS },
    {
      async notifyLogout() {
        return true;
      },
      async audit() {
        throw new Error("audit_logs 표가 죽었다");
      },
    }
  );
  assert.deepEqual(outcome, { cut: true, skipped: null, failed: false });
});

// ───── 감사 기록 ─────

test("감사 기록은 정지 쪽과 같은 꼴이다 — SESSION_REVOKED에 까닭과 실패 여부", async () => {
  const { deps, audited } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);

  assert.equal(audited.length, 1);
  const entry = audited[0];
  assert.equal(entry.actionType, "SESSION_REVOKED");
  assert.equal(entry.actorUserId, TARGET.actorUserId);
  assert.equal(entry.clientId, "rf-service-system");
  // 지워진 부여 행을 가리킨다 — GRANT_REMOVED와 같은 행이라 두 줄이 한 사건으로 읽힌다.
  assert.equal(entry.targetEntity, "user_client_grants");
  assert.equal(entry.targetRecordId, TARGET.grantRecordId);
  assert.equal(entry.newValue.reason, "ACCESS_REVOKED");
  assert.equal(entry.newValue.userId, TARGET.userId);
  assert.equal(entry.newValue.displayName, "홍길동");
  assert.equal(entry.newValue.cut, true);
  assert.equal(entry.newValue.backchannelFailed, false);
});

test("끊지 않은 경우도 기록한다 — 왜 안 끊었는지가 남아야 한다", async () => {
  const { deps, audited } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: OPEN_TO_ALL }, deps);

  assert.equal(audited.length, 1);
  assert.equal(audited[0].newValue.cut, false);
  assert.equal(audited[0].newValue.skipped, "NO_GRANT_CHECK");
  assert.match(audited[0].newValue.note ?? "", /전 직원 공개/);
});

test("성공한 통보에는 군더더기 설명을 붙이지 않는다", async () => {
  const { deps, audited } = spy();
  await cutSessionsForRevokedGrant({ ...TARGET, client: AS }, deps);
  assert.equal(audited[0].newValue.note, undefined);
});

// ───── 관리자에게 보여 주는 말 ─────

test("끊었으면 끊었다고 말한다", () => {
  const notice = sessionCutNotice({ cut: true, skipped: null, failed: false });
  assert.match(notice, /세션도 끊었습니다/);
});

test("🔴 통보 실패를 성공처럼 말하지 않는다", () => {
  const notice = sessionCutNotice({ cut: true, skipped: null, failed: true });
  assert.match(notice, /통보하지 못했습니다/);
  assert.match(notice, /만료될 때까지/);
});

test("🔴 전 직원 공개 시스템에서는 막히지 않았다고 말한다", () => {
  const notice = sessionCutNotice({
    cut: false,
    skipped: "NO_GRANT_CHECK",
    failed: false,
  });
  assert.match(notice, /접근은 그대로/);
  // 진짜 차단 수단을 함께 알려 준다. 이 말이 없으면 관리자는 막혔다고 믿는다.
  assert.match(notice, /계정을 정지/);
});

test("통보 주소가 없을 때도 숨기지 않는다", () => {
  const notice = sessionCutNotice({
    cut: false,
    skipped: "NO_BACKCHANNEL_URI",
    failed: false,
  });
  assert.match(notice, /만료될 때까지/);
});

// ───── 부르는 자리 ─────

/**
 * 🔴 세션 끊기가 **회수 칸 안에만** 있는지 본다.
 *
 * 권한을 주거나 역할만 바꾸는 길에 이것이 붙으면, 방금 권한을 받은 사람이나
 * 역할이 바뀐 사람이 일하던 화면에서 튕겨 나간다. 그건 시험으로 잡히지 않는
 * 종류의 실수라(주는 길은 "성공"으로 끝난다) 부르는 자리 자체를 못 박는다.
 * bookmark-icon.test.ts가 스크립트 본문을 읽어 확인하는 것과 같은 방식이다.
 */
test("🔴 세션 끊기는 회수 갈래에서만 부른다", () => {
  const source = readFileSync("src/lib/server/actions/admin-access.ts", "utf8");

  const calls = source.split("cutSessionsForRevokedGrant(").length - 1;
  assert.equal(calls, 1, "회수 말고 다른 곳에서도 세션을 끊고 있다");

  const revoke = source.indexOf("// ───── 회수 ─────");
  const roleChange = source.indexOf("// ───── 역할 변경 ─────");
  const callSite = source.indexOf("cutSessionsForRevokedGrant(");
  assert.ok(revoke > 0 && roleChange > revoke, "회수/역할 변경 구분 주석이 사라졌다");
  assert.ok(
    callSite > revoke && callSite < roleChange,
    "세션 끊기가 회수 칸 밖에 있다"
  );
});
