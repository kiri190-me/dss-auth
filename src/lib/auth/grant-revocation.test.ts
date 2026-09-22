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

// ───── 명령줄 도구 ─────
//
// 🔴 화면과 명령줄이 다르게 동작하면, 급할 때 명령줄로 회수하고 "막았다"고
// 믿는다. 아래는 그 둘이 갈라지지 않게 잡아 두는 시험이다. 스크립트는 불러오면
// main()이 돌아 버려(파일 맨 아래) 시험에서 부를 수 없으므로, admin-access.ts를
// 자리로 확인하는 위 시험과 같은 방식으로 본문을 읽는다.

const GRANT_CLI = "scripts/grant-client-access.ts";

test("🔴 명령줄 회수도 세션을 끊는다", () => {
  const source = readFileSync(GRANT_CLI, "utf8");
  assert.equal(
    source.split("cutSessionsForRevokedGrant(").length - 1,
    1,
    "명령줄 회수가 세션을 끊지 않는다"
  );
});

test("🔴 명령줄은 화면과 같은 판정을 쓴다 — 판정을 두 벌로 만들지 않았다", () => {
  const source = readFileSync(GRANT_CLI, "utf8");

  assert.ok(
    source.includes('from "../src/lib/auth/grant-revocation"'),
    "명령줄이 판정을 불러 쓰지 않는다"
  );
  // 스크립트가 자기 판정을 따로 갖기 시작하면 두 길이 다시 갈라진다.
  assert.ok(!source.includes("function decideSessionCut"), "판정이 두 벌이 됐다");
  assert.ok(!source.includes("requiresGrant ?"), "스크립트가 자기 판정을 쓰고 있다");
});

test("🔴 명령줄이 권한을 줄 때는 끊지 않는다", () => {
  const source = readFileSync(GRANT_CLI, "utf8");

  const revoke = source.indexOf("if (revoke) {");
  const callSite = source.indexOf("cutSessionsForRevokedGrant(");
  // 회수 갈래 다음에 오는 것이 역할 변경(if (existing))과 새로 부여(insert)다.
  const roleChange = source.indexOf("if (existing) {", revoke);
  const insert = source.indexOf(".insert(userClientGrants)");

  assert.ok(revoke > 0, "회수 갈래가 사라졌다");
  assert.ok(roleChange > revoke && insert > revoke, "부여 갈래의 자리가 바뀌었다");
  assert.ok(
    callSite > revoke && callSite < roleChange && callSite < insert,
    "세션 끊기가 권한을 주는 갈래까지 번졌다"
  );
});

test("🔴 끊는 사람은 --user 다, --by 가 아니다", () => {
  const source = readFileSync(GRANT_CLI, "utf8");
  const start = source.indexOf("cutSessionsForRevokedGrant(");
  const call = source.slice(start, source.indexOf("{ notifyLogout", start));

  // 여기가 뒤바뀌면 회수를 실행한 관리자가 로그아웃되고, 정작 권한을 빼앗긴
  // 사람은 계속 일한다. 오류 없이 지나가는 종류의 실수다.
  assert.ok(call.includes("userId: target.id"), "끊는 대상이 --user 가 아니다");
  assert.ok(call.includes("actorUserId: actor.id"), "행위자 기록이 빠졌다");
  assert.ok(!call.includes("userId: actor.id"), "🔴 관리자를 끊고 있다");
});

test("🔴 「끊기지 않습니다」던 거짓말이 사라졌다", () => {
  const source = readFileSync(GRANT_CLI, "utf8");
  assert.ok(
    !source.includes("이미 발급된 세션은 이 명령으로 끊기지 않습니다"),
    "이제 끊는데 안 끊는다고 찍고 있다"
  );
  // 무엇이 일어났는지는 화면과 같은 문구로 알린다.
  assert.ok(source.includes("sessionCutNotice("), "결과를 알리지 않는다");
});

test("🔴 명령줄이 세션을 끊을 수 있는 환경으로 등록돼 있다", () => {
  // sendLogoutNotice는 "server-only" 모듈을 거친다. --conditions=react-server
  // 없이 부르면 import 에서 프로세스가 죽어, 회수 자체가 안 된다.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["client:grant"], /--conditions=react-server/);
});

test("전 직원 공개 시스템은 명령줄에서도 건너뛴다 — 판정이 하나라서 공짜다", () => {
  // 명령줄에만 따로 예외를 둘 필요가 없다는 것을 값으로 확인한다.
  assert.equal(decideSessionCut(OPEN_TO_ALL), "NO_GRANT_CHECK");
});

test("🔴 역할을 쓰지 않는 시스템(dss-po)도 권한을 빼면 세션을 끊는다", async () => {
  // 역할 목록이 비어 있는 것과 권한 확인을 하는 것은 서로 무관하다.
  // 판정은 requiresGrant만 본다.
  const PO: RevokedClient = {
    clientId: "dss-po",
    requiresGrant: true,
    isActive: true,
    backchannelLogoutUri: "http://po.test/api/auth/sso/backchannel-logout",
  };
  const { deps, notified } = spy();
  const outcome = await cutSessionsForRevokedGrant({ ...TARGET, client: PO }, deps);

  assert.deepEqual(outcome, { cut: true, skipped: null, failed: false });
  assert.deepEqual(
    notified.map((call) => [call.userId, call.clientId]),
    [[TARGET.userId, "dss-po"]]
  );
});
