/**
 * ============================================================================
 * 포털과 세 집의 **결재권 위임이 같은 말을 하고 있는가** (설계 B-14 · C-9)
 * ============================================================================
 *   npm run check:delegations
 *
 * 왜 필요한가: 포털이 위임을 지정·철회하면 세 집(A/S · 재고관리 · 휴가)에 전파하고
 * **셋이 다 성공했을 때만** 포털에 적는다(설계 B-13). 🔴 **그래도 틈이 하나 남는다** —
 * 「전파는 다 됐는데 포털 저장이 실패하고 되돌리기까지 실패한」 자리다. 거기서
 * `delegation-push.ts` 의 `revertPush` 가 **콘솔에 `id` 를 남기며** 「조각 9(어긋남
 * 점검)가 이 번호로 찾아간다」고 적어 두었다. 이 도구가 그 점검이다.
 *
 * 🔴 **실제로 한 번 갈렸다.** 같은 규약을 세 집에 줬는데 「`revokedAt` 에 널이 오면?」을
 * 안 적어서 A/S 는 안 지우고 재고관리·휴가는 지웠다(설계 B-15). **세 집 모두 제 시험을
 * 통과하고 있었고**, 잡은 방법은 맞대어 보기뿐이었다.
 *
 * ── 🔴 아무것도 바꾸지 않는다 ────────────────────────────────────────────
 * 포털 DB 는 **읽기만** 하고, 세 집에는 **읽기 요청만** 보낸다. 🔴 **`--apply` 같은
 * 깃발을 두지 않았다** — 본보기(A/S 의 `check-requested-due-date-sync.ts`)도 일부러 안
 * 두었고, 재전파·수정은 이 조각의 일이 아니다(설계 C-9 ⑥).
 *
 * ── 🔴 세 집 DB 에 직접 붙지 않는다 ──────────────────────────────────────
 * 포털이 세 집의 DB 자격을 들고 비교하면 **포털 하나가 뚫릴 때 넷이 함께** 뚫린다
 * (설계 C-9 ①). 그래서 세 집에는 **통로로** 묻는다 — 그 길은 이미 서 있다
 * (A/S `623fcc3a` · 재고관리 `9928e3e` · 휴가 `09fe333`).
 *
 * ── 🔴 사람을 찍지 않는다 ────────────────────────────────────────────────
 * 집이 돌려주는 칸은 넷뿐이고 사람이 없다. 포털 쪽은 사람 번호를 읽지만(접근 권한을
 * 재려고) **출력에는 한 번도 안 찍는다** — 어긋난 줄은 `id` 로 가리킨다. 그 번호가
 * 포털 로그의 `[delegations]` 줄과 짝이 맞는다.
 *
 * ── ✓ · ✗ · ? 세 상태다. 🔴 **「못 쟀다」를 통과로 세지 않는다** ────────────
 * 서버가 안 떠 있거나, 토큰을 거절당했거나, 「포털에만 있는 줄」의 까닭을 못 찾았으면
 * 그것은 **통과가 아니다.** A/S 의 `check-inventory-contract.ts` 와 같은 가름이고,
 * 거기서처럼 **못 잰 것이 하나라도 있으면 종료 코드가 1** 이다.
 *
 * ── 🔵 개발 DB 에서는 ? 가 나오는 것이 정상이다 ──────────────────────────
 * 받는 통로가 서기 전(2026-11-16 새벽)에 만들어진 줄들은 **애초에 전파된 적이 없어**
 * 세 집 어디에도 없다. 그 줄은 「포털에만 있다」로 보이는데, 전파 때 `not_applicable`
 * 이었던 줄과 **DB·통로만으로는 구별되지 않는다**(설계 C-9 ⑤). 🔴 그래서 「어긋남」이
 * 아니라 **「설명 안 되는 것」**으로 센다 — 개발 DB 숫자로 「운영이 어긋나 있다」고 읽지
 * 말 것.
 *
 * `--conditions=react-server` 로 도는 까닭은 `check:notify` 와 같다 — 이 스크립트가
 * 부르는 조회가 `server-only` 모듈이다.
 * ============================================================================
 */
import { asc } from "drizzle-orm";
import { getIssuer } from "../src/lib/config/env";
import { getSigningKey } from "../src/lib/crypto/keys";
import { db } from "../src/lib/db/client";
import { pgClient } from "../src/lib/db/connection";
import { approvalDelegations } from "../src/lib/db/schema";
import {
  getActiveClient,
  hasClientAccess,
  type ClientRecord,
} from "../src/lib/db/queries/oidc-clients";
import { listClientsByClientIds } from "../src/lib/db/queries/clients";
import {
  PORTAL_SERVICE_TOKEN_PURPOSES,
  signPortalServiceToken,
} from "../src/lib/oidc/service-token";
import { APPROVAL_SOURCE_CLIENT_IDS, planDelegationPush } from "../src/lib/approvals/sources";
import {
  compareDelegations,
  delegationListRequestBody,
  delegationSyncFindings,
  delegationSyncUnmeasured,
  describeDelegationListFailure,
  readDelegationListReply,
  type DelegationComparison,
  type DelegationMismatch,
  type PortalDelegationSnapshot,
} from "../src/lib/approvals/delegation-sync";

let passed = 0;
let failed = 0;
/** 🔴 **못 쟀다.** 통과가 아니다 — 끝에서 종료 코드를 1 로 만든다. */
let unmeasured = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 🔴 재지 **못한** 것. ✓ 도 ✗ 도 아니다 — 둘 중 하나로 접으면 거짓말이 된다. */
function cannotMeasure(label: string, why: string) {
  unmeasured += 1;
  console.log(`  ? ${label} — 못 쟀다 (${why})`);
}

function note(line: string) {
  console.log(`     ${line}`);
}

/**
 * 번호를 몇 개까지 줄줄이 적을까. 🔵 상한이 2000 이라 다 적으면 출력이 묻힌다.
 * 🔴 **셈은 언제나 전부를 말한다** — 줄이는 것은 보여 주는 번호뿐이다.
 */
const IDS_SHOWN = 20;

/**
 * 번호를 줄줄이 적는다. 🔵 **만든 날을 함께 적는다.**
 *
 * 🔴 「포털에만 있다」를 손으로 가를 때 **그것 하나가 단서**였다. 받는 통로가 선
 * 2026-11-16 저녁 **이전**에 만들어진 줄은 애초에 전파된 적이 없어 세 집 어디에도
 * 없고(설계 C-9), 그 뒤에 만들어진 줄이 한 집에만 없으면 **그 집 계정이 없어
 * `not_applicable` 이었다**는 뜻이다. 날짜가 없으면 두 경우가 출력에서 똑같아 보인다.
 * 🔵 시각은 사람 자료가 아니다 — 사람 번호·사유는 여전히 한 번도 안 찍는다.
 */
function listIds(ids: readonly string[], createdAt?: ReadonlyMap<string, Date>) {
  for (const id of ids.slice(0, IDS_SHOWN)) {
    const born = createdAt?.get(id);
    note(`· ${id}${born ? `  (만든 날 ${born.toISOString()})` : ""}`);
  }
  if (ids.length > IDS_SHOWN) note(`· … 외 ${ids.length - IDS_SHOWN}개`);
}

function listMismatches(rows: readonly DelegationMismatch[]) {
  for (const row of rows.slice(0, IDS_SHOWN)) {
    const where = row.diffs
      .map((diff) => `${diff.field} 포털=${diff.portal ?? "없음"} 집=${diff.house ?? "없음"}`)
      .join(" · ");
    note(`· ${row.id}  ${where}`);
  }
  if (rows.length > IDS_SHOWN) note(`· … 외 ${rows.length - IDS_SHOWN}개`);
}

/**
 * 토큰의 `sub` 에 실을 값.
 *
 * 🔴 **사람 번호를 싣지 않는다.** 전파는 「그 지정을 누른 사람」을 싣는다
 * (`delegation-push-service.ts`) — 저쪽 접근 로그에 「포털이 누구의 일로 왔나」가
 * 남아야 하기 때문이다. 🔴 이 점검에는 **그 사람이 없다.** 아무 직원 번호나 골라
 * 실으면 세 집의 접근 로그에 **그 사람이 회사 전체의 위임 장부를 읽어 간 것으로** 남는다
 * — 거짓이고, 나중에 그 로그를 읽는 사람이 그것을 믿는다.
 *
 * 🔵 세 집은 이 갈래에서 `sub` 를 **읽지 않는다**(셋의 통로 머리말이 그렇게 적어 두었다).
 * 다만 검증기가 **비어 있지 않은 `sub`** 를 요구하므로 무엇이든 실어야 한다.
 * 🔴 혹시 어느 집이 이 값으로 사람을 되짚기 시작하면 그 집은 **401** 을 주게 되고, 이
 * 점검은 그것을 「못 쟀다」로 센다 — **「집에 없다」로 읽지 않는다.** 조용히 틀리는 길이
 * 아니라 눈에 띄게 멈추는 길이다.
 */
const SYNC_TOKEN_SUBJECT = "portal:delegation-sync";

/** 한 번 두드린다. 🔵 던지지 않는다 — 한 집이 죽어도 나머지 둘은 재야 한다. */
async function ask(
  url: string,
  token: string
): Promise<{ status: number; body: unknown; ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        // 🔴 세 집 규약은 JSON 이다(휴가만 폼 인코딩도 받는다).
        "content-type": "application/json",
        accept: "application/json",
      },
      body: delegationListRequestBody(),
      redirect: "manual",
      cache: "no-store",
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    console.log(`     (연결 실패: ${error instanceof Error ? error.message : String(error)})`);
    return { status: 0, body: null, ms: Date.now() - started };
  }
}

/** 포털 표에서 읽는 줄. 🔴 사람 번호는 **접근 권한을 재는 데만** 쓰고 찍지 않는다. */
type PortalRow = {
  id: string;
  delegatorUserId: string;
  delegateUserId: string;
  startsAt: Date;
  endsAt: Date;
  revokedAt: Date | null;
  /** 🔵 **판정에는 안 쓴다** — 「포털에만 있다」를 사람이 가를 때 쓰는 단서다(`listIds`). */
  createdAt: Date;
};

/**
 * 「둘 다 이 집에 들어갈 수 있나」를 재는 자 하나.
 *
 * 🔴 **판정을 베껴 적지 않는다** — 런처 타일·인가 단계가 쓰는 `hasClientAccess` 를
 * 그대로 부른다. 베껴 두면 한쪽만 고치는 날 이 점검이 「설명됨」과 「설명 안 됨」을
 * 다른 잣대로 가르게 되고, 그 어긋남은 **아무 오류도 내지 않는다.**
 * 🔵 질의가 늘지만 사람 수가 본질적으로 작고 같은 사람을 다시 묻지 않는다.
 */
function accessCheckerFor(record: ClientRecord | null) {
  const cache = new Map<string, boolean>();
  return async (userId: string): Promise<boolean> => {
    // 🔴 클라이언트 줄을 못 읽었으면 **「들어갈 수 있다」 쪽으로 둔다.** 그러면 포털에만
    //    있는 줄이 「설명됨(=정상)」이 아니라 「설명 안 되는 것(=못 쟀다)」으로 떨어진다 —
    //    모르는 것을 조용한 ✓ 로 접지 않는 쪽이다.
    if (record === null) return true;
    const known = cache.get(userId);
    if (known !== undefined) return known;
    const fresh = await hasClientAccess(userId, record);
    cache.set(userId, fresh);
    return fresh;
  };
}

/** 한 집의 결과를 사람이 읽을 모양으로 찍는다. */
function reportComparison(comparison: DelegationComparison, createdAt: ReadonlyMap<string, Date>) {
  // 🔵 **값을 재어 본 줄만** 센다 — 시각을 못 읽은 줄은 아래에서 따로 ? 로 나온다.
  //    여기 함께 세면 「다 같다」가 재지도 않은 줄을 품게 된다.
  check(
    `양쪽에 있고 값을 재어 본 줄 ${comparison.matched.length + comparison.mismatched.length + comparison.revokedInHouseOnly.length}개가 다 같다`,
    comparison.mismatched.length === 0,
    `값이 갈린 줄 ${comparison.mismatched.length}개 — 설계 B-15 가 갈렸던 바로 그 자리다`
  );
  if (comparison.mismatched.length > 0) listMismatches(comparison.mismatched);

  check(
    "🔴 집에만 있는 줄이 없다 (포털에서 거둔 줄 알았는데 살아 있는 쪽)",
    comparison.houseOnly.length === 0,
    `집에만 있는 줄 ${comparison.houseOnly.length}개`
  );
  if (comparison.houseOnly.length > 0) listIds(comparison.houseOnly);

  if (comparison.revokedInHouseOnly.length > 0) {
    cannotMeasure(
      `🔵 포털은 안 거뒀는데 집은 거둬진 줄 ${comparison.revokedInHouseOnly.length}개`,
      "철회 전파를 되돌리지 않기로 한 결정이 남기는 모양이라 설계대로일 수 있다 — " +
        "사람이 [되돌리기]를 다시 누르면 같은 번호로 다시 전파되어 양쪽이 맞는다"
    );
    listMismatches(comparison.revokedInHouseOnly);
  }

  if (comparison.unexplainedPortalOnly.length > 0) {
    cannotMeasure(
      `🔴 포털에만 있고 까닭을 못 찾은 줄 ${comparison.unexplainedPortalOnly.length}개`,
      "양쪽 사람이 **둘 다** 이 집에 들어갈 수 있는데 줄이 없다 — 접근 권한과 그 집 계정의 " +
        "존재가 완전히 같지는 않으므로 **어긋남으로 단정하지 않는다**"
    );
    listIds(comparison.unexplainedPortalOnly, createdAt);
  }

  if (comparison.unmeasuredByTruncation.length > 0) {
    cannotMeasure(
      `🔴 집 답이 잘려서 못 본 줄 ${comparison.unmeasuredByTruncation.length}개`,
      "truncated=true 다 — 안 온 줄을 「집에 없다」로 읽으면 안 된다"
    );
  }

  if (comparison.unreadable.length > 0) {
    cannotMeasure(
      `🔴 집이 보낸 시각을 못 읽은 줄 ${comparison.unreadable.length}개`,
      "시간대가 안 붙었거나 ISO 가 아니다 — 지역 시각으로 읽으면 아홉 시간 어긋난다"
    );
    listIds(comparison.unreadable);
  }

  note(
    `같음 ${comparison.matched.length} · 값 갈림 ${comparison.mismatched.length} · ` +
      `집에만 ${comparison.houseOnly.length} · 포털에만(설명됨) ${comparison.explainedPortalOnly.length} · ` +
      `포털에만(설명 안 됨) ${comparison.unexplainedPortalOnly.length}`
  );
}

async function main() {
  console.log(`\n포털 issuer: ${getIssuer()}`);

  /* 🔴 **거르개가 하나도 없다.** 살아 있는 것·끝난 것·거둔 것 전부다 — 화면용 조회
     (`listApprovalDelegationsForUser`·`listAllApprovalDelegations`)는 사람으로 좁히거나
     끝난 줄에 상한을 걸어서, 빌려 쓰면 맞대어 보기가 바로 그 자리에서 눈이 먼다.
     🔵 사람 칸 둘을 읽지만 **접근 권한을 재는 데만** 쓰고 출력에는 안 찍는다. */
  const portalRows: PortalRow[] = await db
    .select({
      id: approvalDelegations.id,
      delegatorUserId: approvalDelegations.delegatorUserId,
      delegateUserId: approvalDelegations.delegateUserId,
      startsAt: approvalDelegations.startsAt,
      endsAt: approvalDelegations.endsAt,
      revokedAt: approvalDelegations.revokedAt,
      createdAt: approvalDelegations.createdAt,
    })
    .from(approvalDelegations)
    .orderBy(asc(approvalDelegations.id));

  const createdAt = new Map(portalRows.map((row) => [row.id, row.createdAt]));
  const revoked = portalRows.filter((row) => row.revokedAt !== null).length;
  console.log(`포털 위임 ${portalRows.length}줄 (거둔 줄 ${revoked})\n`);

  /* 🔴 **맞대어 볼 곳은 써 준 곳과 같아야 한다** — 전파가 쓰는 그 계획을 그대로 쓴다
     (`planDelegationPush`). 목록을 여기 또 적으면 한쪽이 조용히 낡고, 그러면 **전파는
     갔는데 점검은 안 묻는** 집이 생긴다. */
  const plan = planDelegationPush(await listClientsByClientIds(APPROVAL_SOURCE_CLIENT_IDS));

  for (const row of plan.unreachable) {
    // 🔴 전파도 이 집에는 못 간다는 뜻이다(그러면 지정 자체가 거절된다 — 설계 B-13).
    cannotMeasure(`${row.clientId} 와 맞대어 보기`, `주소를 모른다 (${row.reason})`);
  }

  if (plan.targets.length === 0) {
    cannotMeasure("🔴 세 집과 맞대어 보기 전부", "물어볼 곳이 한 곳도 없다");
  }

  // 🔴 **빈 표본으로 공짜 통과시키지 않는다.** 포털에 줄이 하나도 없으면 아래 판정은
  //    전부 참이 되는데, 그것은 「맞다」가 아니라 「잴 것이 없었다」이다.
  if (portalRows.length === 0) {
    cannotMeasure(
      "🔴 맞대어 보기 전부",
      "포털에 결재권 위임이 한 줄도 없다 — 승인함에서 한 번 맡겨 둔 뒤 다시 돌리십시오"
    );
  }

  const { key, kid } = await getSigningKey();

  for (const target of plan.targets) {
    console.log(`\n─ ${target.name} (${target.clientId})`);

    const token = await signPortalServiceToken({
      issuer: getIssuer(),
      audience: target.clientId,
      subject: SYNC_TOKEN_SUBJECT,
      // 🔴 **읽기 쓰임새다.** 전파가 굽는 쓰기 쓰임새를 돌려쓰면 세 집이 401 로 막는다.
      purpose: PORTAL_SERVICE_TOKEN_PURPOSES.delegationsRead,
      key,
      kid,
    });

    const answer = await ask(target.delegationsUrl, token);
    const reply = readDelegationListReply(answer.status, answer.body);
    if (!reply.ok) {
      // 🔴 **200 이 아닌 답은 전부 「못 쟀다」**다. 「집에 없다」로 세면 그 집 위임이
      //    통째로 어긋난 것으로 보고된다.
      cannotMeasure(
        `${target.name} 와 맞대어 보기`,
        `status ${answer.status} · ${describeDelegationListFailure(reply.reason)}`
      );
      continue;
    }
    check(`읽기 갈래가 200 으로 답하고 몸통이 규약 모양이다 (${answer.ms}ms)`, reply.ok);
    note(`집이 가진 줄 ${reply.entries.length}개 · truncated=${reply.truncated}`);

    if (portalRows.length === 0 && reply.entries.length === 0) {
      // 위에서 이미 한 번 셌다. 여기서 또 세면 같은 사실이 두 번 ? 가 된다.
      note("포털에도 집에도 줄이 없다 — 맞대어 볼 것이 없다.");
      continue;
    }

    const canEnter = accessCheckerFor(await getActiveClient(target.clientId));
    const portal: PortalDelegationSnapshot[] = [];
    for (const row of portalRows) {
      portal.push({
        id: row.id,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        revokedAt: row.revokedAt,
        // 🔴 **둘 다**여야 한다 — 한 사람만 없어도 그 집은 `not_applicable` 로 끝난다.
        bothHaveAccess: (await canEnter(row.delegatorUserId)) && (await canEnter(row.delegateUserId)),
      });
    }

    const comparison = compareDelegations({
      portal,
      house: reply.entries,
      truncated: reply.truncated,
    });
    reportComparison(comparison, createdAt);

    if (delegationSyncFindings(comparison) === 0 && delegationSyncUnmeasured(comparison) === 0) {
      note("이 집은 포털과 한 줄도 어긋나지 않았다.");
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`  통과 ${passed} · 어긋남 ${failed} · 못 쟀다 ${unmeasured}`);
  if (unmeasured > 0) {
    console.log("  🔴 못 잰 것은 통과가 아니다 — 위의 ? 줄을 먼저 없애고 다시 돌리십시오.");
    console.log(
      "  🔵 「포털에만 있고 까닭을 못 찾은 줄」은 어긋남이 아니다. 받는 통로가 서기 전\n" +
        "     (2026-11-16 새벽)에 만들어진 줄은 애초에 전파된 적이 없어 세 집 어디에도 없다."
    );
  }
  if (failed > 0 || unmeasured > 0) {
    console.log(
      "  🔵 포털 서버 로그에서 `[delegations]` 를 함께 찾아보십시오 — 되돌리기까지 실패한\n" +
        "     자리는 거기에만 번호가 남습니다(approvals/delegation-push.ts 의 revertPush)."
    );
  }
  console.log("─".repeat(72) + "\n");
  if (failed > 0 || unmeasured > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
