import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  authorizeDelegationCreate,
  checkDelegationRevocable,
  DELEGATION_ADMIN_ROLE,
  DELEGATION_STAFF_ROLE,
  isDelegationAdmin,
  type DelegationActorAuthority,
} from "./delegation";
import { candidatesForActor, type DelegateCandidate } from "./delegation-request";

/**
 * ============================================================================
 * 승인함 역할이 포털 관리자 깃발을 이긴다 — **넷이 함께 좁아진다** (2026-11-18)
 * ============================================================================
 * 신고는 한 줄이었다: 「통합 승인함의 역할이 STAFF 인데 **남의 결재권도 위임**할 수
 * 있다」. STAFF 판정 자체는 멀쩡했고, 그 사람이 지나간 길은 하나뿐이었다 —
 * `isDelegationAdmin` 의 첫 줄에 있던 `isPortalAdmin` 이다(DB 실측: 그 계정은
 * `is_portal_admin = true` · 승인함 역할 `STAFF`).
 *
 * ── 🔴 왜 **따로 한 파일**인가 ─────────────────────────────────────────
 * 그 한 줄이 여는 문이 **넷**이고, 넷이 서로 다른 모듈에 흩어져 있기 때문이다:
 *
 *   ① 남의 위임 **세우기**     — `authorizeDelegationCreate`  (delegation.ts)
 *   ② 남의 위임 **거두기**     — `checkDelegationRevocable`   (delegation.ts)
 *   ③ **모두의 위임 목록**     — `listAllApprovalDelegations` (db/queries/…)
 *   ④ 고르개의 **이메일 공개** — `candidatesForActor`         (delegation-request.ts)
 *
 * 🔴 각자 제 파일의 시험에서 재면 **「세우기만 막혔다」로 끝나고 나머지 셋이 조용히
 * 갈린다.** 갈린 것이 인가면 증상이 없다 — 「목록에는 뜨는데 눌리지는 않는」(또는 그
 * 반대의) 짝이 생기고 아무도 오류를 못 본다. 그래서 **넷을 한 자리에서 같은 사람에게
 * 물어** 답이 하나로 움직이는지를 잰다.
 *
 * ── 🔴 ③ 만 모양이 다르다 ───────────────────────────────────────────────
 * ③ 은 DB 조회 안에 있어 여기서 돌릴 수 없다. 그 함수가 하는 일은 **DB 에서 읽은 두 칸을
 * 그대로 `isDelegationAdmin` 에 넘기는 것**뿐이라, 여기서는 그 함수를 직접 물어 보고
 * **조회가 제 판정을 따로 적지 않았는지**는 맨 아래 소스 시험이 지킨다. 둘을 합쳐야
 * ③ 을 잰 것이 된다 — 한쪽만 두면 조회가 옛 깃발로 되돌아간 날이 안 걸린다.
 * ============================================================================
 */

/** 🔴 값은 전부 가짜다. 실제 사람 번호도 이름도 시험에 넣지 않는다. */
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-11-18T03:00:00.000Z");
/** 🔵 아직 안 끝난 줄이어야 한다 — 끝난 줄은 등급을 보기 전에 막힌다(차례에 뜻이 있다). */
const ENDS = new Date("2026-11-30T00:00:00.000Z");

const CANDIDATES: readonly DelegateCandidate[] = [
  { sub: OTHER, name: "홍길동", email: "hong@example.invalid" },
  { sub: THIRD, name: "김철수", email: null },
];

/**
 * 「남의 결재권까지 다룰 수 있나」가 여는 문 **넷**. `true` 가 열린 쪽이다.
 *
 * 🔴 넷 다 **남의 것**으로 묻는다. 본인 것으로 물으면 등급을 보기 **전에** 통과해 버려
 * (①은 `actorUserId === delegatorUserId`, ②는 맡긴 본인) **재려는 것을 못 잰다** —
 * 그런 시험은 판정을 통째로 지워도 초록이 뜬다.
 */
type DelegationDoors = {
  세우기: boolean;
  거두기: boolean;
  모두보기: boolean;
  이메일: boolean;
};

function doorsFor(actor: DelegationActorAuthority): DelegationDoors {
  return {
    // ① 남의 결재권을 맡긴다.
    세우기: authorizeDelegationCreate({
      actorUserId: ME,
      delegatorUserId: OTHER,
      actor,
    }).ok,
    // ② 🔴 **제3자로** 묻는다 — 맡긴 사람도 맡은 사람도 아니다. 당사자로 물으면 등급
    //    이전에 갈려(본인은 통과, 대리인은 `DELEGATE_CANNOT_REVOKE`) 등급을 못 잰다.
    거두기: checkDelegationRevocable({
      delegation: {
        delegatorUserId: OTHER,
        delegateUserId: THIRD,
        endsAt: ENDS,
        revokedAt: null,
      },
      actorUserId: ME,
      actor,
      now: NOW,
    }).ok,
    // ③ 「모두의 결재권 위임」 — 조회가 DB 에서 읽은 두 칸으로 **이 함수에** 묻는다.
    //    (조회가 그 한 줄을 그대로 쥐고 있는지는 맨 아래 소스 시험이 지킨다.)
    모두보기: isDelegationAdmin(actor),
    // ④ 대리인 고르개에 이메일을 싣는가. 🔵 「실렸나」가 아니라 **「문이 열렸나」**를
    //    말하는 칸이라, 후보의 이메일이 전부 비어 있어도 값이 흔들리지 않는다.
    이메일: candidatesForActor(CANDIDATES, actor).emailsIncluded,
  };
}

const 넷다열림: DelegationDoors = {
  세우기: true,
  거두기: true,
  모두보기: true,
  이메일: true,
};
const 넷다닫힘: DelegationDoors = {
  세우기: false,
  거두기: false,
  모두보기: false,
  이메일: false,
};

// ─────────────────────────── 이 조각이 뒤집은 것

test("🔴 승인함 역할이 **STAFF** 면 포털 관리자 깃발이 진다 — 넷이 **함께** 닫힌다", () => {
  // 🔵 먼저 **무엇을 재는지**를 못 박는다. 같은 깃발에 역할만 없는 사람이 넷을 다 여는
  //    것을 보이지 않으면, 아래 단언은 「넷이 애초에 닫혀 있었다」로도 통과한다.
  assert.deepEqual(
    doorsFor({ clientRole: null, isPortalAdmin: true }),
    넷다열림,
    "표본이 비었다 — 깃발로 넷이 열리는 모양이 실제로 있어야 아래가 뜻을 갖는다"
  );

  // 🔴 **신고된 그 사람**이다: 포털 관리자 깃발이 켜져 있고 승인함 역할은 STAFF.
  assert.deepEqual(
    doorsFor({ clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: true }),
    넷다닫힘,
    "🔴 넷 중 하나라도 true 면 그 문만 옛 동작으로 남은 것이다"
  );
});

test("🔴 좁아진 둘의 거절 **까닭**이 바뀌지 않는다 — FORBIDDEN 이고, 글은 「관리자」다", () => {
  const actor: DelegationActorAuthority = {
    clientRole: DELEGATION_STAFF_ROLE,
    isPortalAdmin: true,
  };

  const 세우기 = authorizeDelegationCreate({
    actorUserId: ME,
    delegatorUserId: OTHER,
    actor,
  });
  assert.equal(세우기.ok, false);
  assert.equal(세우기.ok === false && 세우기.code, "FORBIDDEN");
  // 🔴 막힌 사람이 알아야 하는 것은 **누구에게 말해야 하는가**다. 「포털 관리자에게」로
  //    좁혀 적으면, 이 사람은 **자기가 바로 그 포털 관리자라서** 영원히 헤맨다.
  assert.match(세우기.ok === false ? 세우기.message : "", /본인 또는 관리자/);

  const 거두기 = checkDelegationRevocable({
    delegation: {
      delegatorUserId: OTHER,
      delegateUserId: THIRD,
      endsAt: ENDS,
      revokedAt: null,
    },
    actorUserId: ME,
    actor,
    now: NOW,
  });
  assert.equal(거두기.ok, false);
  assert.equal(거두기.ok === false && 거두기.code, "FORBIDDEN");
});

test("🔴 넷이 **한 함수**를 본다 — 사람을 바꿔 가며 네 답이 갈리는지 본다", () => {
  const 사람들: { 이름: string; actor: DelegationActorAuthority }[] = [
    { 이름: "운영의 여덟 명(역할 없음·깃발 없음)", actor: { clientRole: null, isPortalAdmin: false } },
    { 이름: "STAFF·깃발 없음", actor: { clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: false } },
    { 이름: "🔴 STAFF·포털 관리자 — 신고된 모양", actor: { clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: true } },
    { 이름: "ADMIN·깃발 없음", actor: { clientRole: DELEGATION_ADMIN_ROLE, isPortalAdmin: false } },
    { 이름: "ADMIN·포털 관리자", actor: { clientRole: DELEGATION_ADMIN_ROLE, isPortalAdmin: true } },
    { 이름: "역할 없음·포털 관리자", actor: { clientRole: null, isPortalAdmin: true } },
    { 이름: "모르는 역할·포털 관리자", actor: { clientRole: "AS_ENGINEER", isPortalAdmin: true } },
  ];

  const 답 = 사람들.map(({ actor }) => doorsFor(actor));

  // 🔵 **기대값을 먼저 적는다.** 아래의 「넷이 같은가」만 두면 넷이 다 같이 false 인
  //    고장(판정을 통째로 지운 경우)이 조용히 통과한다.
  assert.deepEqual(
    답.map((문) => 문.세우기),
    [false, false, false, true, true, true, true],
    "기대값이 통째로 흔들렸다 — 어느 사람이 바뀌었는지부터 본다"
  );

  for (const [자리, 문] of 답.entries()) {
    const 이름 = 사람들[자리].이름;
    assert.equal(문.거두기, 문.세우기, `${이름}: 세우기와 거두기가 갈렸다`);
    assert.equal(문.모두보기, 문.세우기, `${이름}: 세우기와 모두보기가 갈렸다`);
    assert.equal(문.이메일, 문.세우기, `${이름}: 세우기와 이메일 공개가 갈렸다`);
  }
});

test("🔴 ADMIN 역할은 **한 톨도** 좁아지지 않는다 — 깃발이 있든 없든 넷 다", () => {
  assert.deepEqual(doorsFor({ clientRole: DELEGATION_ADMIN_ROLE, isPortalAdmin: false }), 넷다열림);
  assert.deepEqual(doorsFor({ clientRole: DELEGATION_ADMIN_ROLE, isPortalAdmin: true }), 넷다열림);
});

test("🔴 **제 결재권은 STAFF 도 맡긴다** — 좁힌 것은 「남의 것」뿐이다", () => {
  // 🔴 이 길이 막히면 자리를 비우는 사람이 **매번 관리자에게 부탁해야** 한다. 기능이
  //    있는 까닭 자체가 사라지므로, 좁히는 조각마다 여기부터 다시 잰다.
  for (const actor of [
    { clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: false },
    { clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: true },
    { clientRole: null, isPortalAdmin: false },
  ] satisfies DelegationActorAuthority[]) {
    assert.equal(
      authorizeDelegationCreate({ actorUserId: ME, delegatorUserId: ME, actor }).ok,
      true,
      "제 결재권을 맡기는 길이 막혔다"
    );
    // 맡긴 본인이 제 위임을 거두는 길도 그대로다.
    assert.equal(
      checkDelegationRevocable({
        delegation: {
          delegatorUserId: ME,
          delegateUserId: OTHER,
          endsAt: ENDS,
          revokedAt: null,
        },
        actorUserId: ME,
        actor,
        now: NOW,
      }).ok,
      true,
      "제가 맡긴 것을 제가 거두는 길이 막혔다"
    );
  }
});

test("🔴 역할을 **모르는 것**은 STAFF 가 아니다 — `null` 앞에서는 깃발이 그대로 이긴다", () => {
  // ── 이 조각의 유일한 판단이고, 까닭은 **운영 실측**이다 ────────────────
  // 승인함에 접근이 부여된 여덟 명 전원의 역할이 `null` 이다(2026-11-16 실측). `null`
  // 까지 깃발을 물리면 **운영의 포털 관리자가 넷을 전부 잃고**, 거기엔 「모두의 위임
  // 목록」도 들어 있어 남이 세워 둔 위임을 **볼 수도 거둘 수도 없는** 상태가 된다.
  // 🔵 「STAFF 라고 적음」은 사람이 내린 결정이고 `null` 은 아무도 정한 적이 없다는
  //    뜻이다 — 다른 상태를 같게 다루지 않는다.
  assert.deepEqual(doorsFor({ clientRole: null, isPortalAdmin: true }), 넷다열림);
  assert.deepEqual(
    doorsFor({ clientRole: "AS_ENGINEER", isPortalAdmin: true }),
    넷다열림,
    "모르는 역할 글자도 「아무도 정한 적 없음」이다"
  );

  // 🔴 그렇다고 「모름」이 그 자체로 문을 열지는 **않는다** — 깃발이 없으면 넷 다 닫힌다.
  //    이 짝이 없으면 위 단언은 「역할만 없으면 다 된다」로도 통과한다.
  assert.deepEqual(doorsFor({ clientRole: null, isPortalAdmin: false }), 넷다닫힘);
  assert.deepEqual(doorsFor({ clientRole: "AS_ENGINEER", isPortalAdmin: false }), 넷다닫힘);
});

test("🔴 글자를 **그대로** 맞댄다 — `staff` 는 STAFF 가 아니다", () => {
  // 대소문자를 눅여 받으면 DB 에 잘못 적힌 값이 맞는 값인 척 지나가고, 그 어긋남은
  // 신고로만 드러난다(역할 글자를 포털이 검사하지 않는다 — schema/clients.ts).
  // 🔵 그래서 `staff` 는 **모르는 글자**로 다뤄진다 = 깃발이 이긴다.
  assert.equal(isDelegationAdmin({ clientRole: "staff", isPortalAdmin: true }), true);
  assert.equal(isDelegationAdmin({ clientRole: "staff", isPortalAdmin: false }), false);
  assert.equal(
    isDelegationAdmin({ clientRole: DELEGATION_STAFF_ROLE, isPortalAdmin: true }),
    false,
    "한 글자 차이가 반대 답이 된다 — 그래서 상수로 맞댄다"
  );
});

// ─────────────────────────── ③ 이 제 판정을 따로 적지 않았나

/**
 * 🔴 **주석을 먼저 걷어낸다.** 이 저장소의 조회·판정 파일은 「왜」를 길게 적어서,
 * 글자로 재는 검사가 주석을 세면 **함수를 한 번도 안 부르고도 통과한다.**
 */
function 주석을걷는다(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("🔴 「모두의 위임」 조회가 판정을 **베껴 적지 않았다** — 넷이 갈라지는 유일한 길", () => {
  const 날것 = readFileSync("src/lib/db/queries/approval-delegations.ts", "utf8");
  const 코드 = 주석을걷는다(날것);

  // 🔵 **걷어내는 일이 실제로 됐는지**부터 본다. 안 됐으면 아래 단언들은 주석을 세고
  //    있는 것이고, 그런 검사는 코드가 사라져도 영영 초록이다.
  assert.match(날것, /판정은 베껴 적지 않고/, "본보기로 삼은 주석이 사라졌다 — 아래 통제가 뜻을 잃는다");
  assert.doesNotMatch(코드, /판정은 베껴 적지 않고/, "주석이 안 걷혔다");
  assert.match(코드, /export async function listAllApprovalDelegations/, "엉뚱한 파일을 읽었다");

  // 🔴 등급을 가르는 자리가 **그 함수 호출 하나**여야 한다.
  assert.match(코드, /isDelegationAdmin\(actor\)/, "조회가 `isDelegationAdmin` 을 부르지 않는다");
  // 🔴 깃발을 **직접** 보는 줄이 돌아오면 안 된다. 2026-11-18 결정이 사는 곳은 순수 함수
  //    한 곳이라, 여기서 깃발을 다시 읽는 순간 이 문만 옛 동작으로 되돌아간다.
  //    🔵 `users.isPortalAdmin`(칸을 읽어 오는 select)은 그대로 있어야 한다 — 그 값이
  //       없으면 판정에 넘길 재료가 없다.
  assert.doesNotMatch(코드, /actor\.isPortalAdmin/, "조회가 깃발을 제 손으로 가른다");
  assert.match(코드, /isPortalAdmin: users\.isPortalAdmin/, "판정에 넘길 깃발을 안 읽어 온다");
  assert.match(코드, /clientRole: userClientGrants\.role/, "판정에 넘길 역할을 안 읽어 온다");
});
