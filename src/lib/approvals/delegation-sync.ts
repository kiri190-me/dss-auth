/**
 * ============================================================================
 * 포털과 세 집의 결재권 위임을 **맞대어 본다** — 판정만 (설계 B-14 · C-9)
 * ============================================================================
 * 포털이 위임을 지정·철회하면 세 집(A/S · 재고관리 · 휴가)에 전파하고 **셋이 다
 * 성공했을 때만** 포털에 적는다(설계 B-13). 🔴 **그래도 틈이 하나 남는다** —
 * 「전파는 다 됐는데 포털 저장이 실패하고 되돌리기까지 실패한」 자리다. 그 자리는
 * `delegation-push.ts` 의 `revertPush` 가 **콘솔에 `id` 를 남기는 곳**이고, 거기
 * 주석이 「조각 9(어긋남 점검)가 이 번호로 찾아간다」고 적어 두었다. 이 파일이
 * 그 점검의 **판정 전부**다.
 *
 * 🔴 **실제로 한 번 갈렸다.** 같은 규약을 세 집에 줬는데 「`revokedAt` 에 널이
 * 오면?」을 안 적어서 A/S 는 안 지우고 재고관리·휴가는 지웠다(설계 B-15).
 * **세 집 모두 제 시험을 통과하고 있었고**, 잡은 방법은 맞대어 보기뿐이었다.
 *
 * ── 🔴 왜 망도 DB 도 여기 없는가 ────────────────────────────────────────
 * 이 조각의 값어치는 **「포털에만 있다」를 어긋남으로 단정하지 않는 것** 하나에
 * 걸려 있다(아래 ④). 그 판단이 망 요청 안에 섞여 있으면 세 집 서버와 포털 DB 가
 * 동시에 특정 상태일 때만 재어 볼 수 있게 되고, 그러면 **아무도 안 잰다.**
 * 그래서 이 파일은 **import 가 한 줄도 없다** — 값만 받아 값으로 답한다.
 * `delegation-push.ts` 가 망도 서명 키도 인자로 받는 것과 같은 판단이다.
 *
 * ── 판정 넷 ──────────────────────────────────────────────────────────────
 *  ① 양쪽에 있고 값이 같다                    → 통과
 *  ② 양쪽에 있는데 값이 다르다                → 🔴 **어긋남.** B-15 가 갈렸던 자리
 *  ③ 집에만 있다                              → 🔴 **어긋남. 이쪽이 더 위험하다** —
 *     포털에서 거둔 줄 알았는데 집에서 살아 있는 경우다
 *  ④ 포털에만 있다                            → 🔴 **어긋남으로 단정하면 안 된다**
 *
 * ── 🔴 ④ 가 이 점검에서 가장 틀리기 쉬운 곳 ──────────────────────────────
 * 전파할 때 위임자·대리인 **둘 중 하나라도 그 집 계정이 없으면** 그 집은 줄을 아예
 * 안 만들고 `200 not_applicable` 로 답한다. **전파 실패가 아니다** — 그래야 재고관리
 * 계정이 없는 사람에게도 A/S 결재권을 맡길 수 있다(설계 B-13). 🔴 **그 사실이 어느
 * 표에도 안 남아서** DB·통로만으로는 「없음」과 「어긋남」을 못 가른다.
 *
 * 🔵 포털은 `hasClientAccess` 로 「그 사람이 그 집에 들어갈 수 있나」를 알고, 그것으로
 * 좁힌다(아래 `bothHaveAccess`). 🔴 **그래도 「어긋남」이라고 부르지 않는다** — 접근
 * 권한과 그 집 계정의 존재가 완전히 같지는 않기 때문이다(A/S 는 `sso_subject` 가 빈
 * 계정, 휴가는 `web_users.employee_id` 가 빈 계정에서 갈린다). 좁히고 남은 것은
 * **「설명 안 되는 것」**이고, 그것은 ✗ 도 ✓ 도 아닌 **「못 쟀다」**다.
 *
 * ── 🔵 「포털은 안 거뒀는데 집은 거둬져 있다」는 설계대로일 수 있다 ───────────
 * 철회 전파가 다 된 뒤 포털 저장만 실패하면 **되돌리지 않는다**(`delegation-push.ts`
 * 의 「철회 전파는 되돌리지 않는다」 — 거둔 줄 알았는데 안 거둬진 쪽이 더 위험해서
 * **덜 열린 쪽으로 기운 채** 남긴다). 그 결과가 정확히 이 모양이다. 거기에 세 집은
 * 덮어쓸 때 **널로 `revoked_at` 을 지우지 않으므로**(한 방향 규칙 — 재고관리
 * `revokedAtOnConflict` · A/S mutations 의 같은 줄) 다시 전파해도 저절로 풀리지
 * 않는다. 🔴 **그래서 따로 센다.** 어긋남 더미에 섞으면 「고칠 수 있는 어긋남」이
 * 「원래 그런 것」에 파묻힌다. 🔵 사람이 [되돌리기]를 다시 누르면 같은 번호로 다시
 * 전파되어 양쪽이 맞는다.
 *
 * 🔴 반대 방향(**포털은 거뒀는데 집은 안 거둬졌다**)은 **진짜 어긋남**이다. 전파가
 * 먼저이고 전파가 실패하면 포털에 적지 않으므로, 포털에 철회가 적혀 있다는 것은
 * 「세 집이 다 거뒀다고 답했다」는 뜻이기 때문이다.
 * ============================================================================
 */

/* ------------------------------------------------------------------ */
/* 집이 내주는 몸통 읽기                                                */
/* ------------------------------------------------------------------ */

/**
 * 읽기 갈래를 고르는 글자. 🔴 **세 집이 같다** — 쓰기 갈래의 `upsert`·`revoke` 와
 * 같은 약속이고, 셋의 `DELEGATION_LIST_ACTION` 이 전부 이 글자다.
 */
export const DELEGATION_LIST_ACTION = "list";

/**
 * 집에 보낼 몸통. 🔴 **`application/json` 으로 나간다** — 세 집의 쓰기 갈래가 처음부터
 * JSON 이고(2026-11-16 규약), 폼 인코딩은 포털이 **제 화면에** 쓰는 다른 통로의 모양이다.
 * 🔵 휴가는 둘 다 받지만 나머지 둘은 JSON 뿐이라, 한 벌로 못 박는다.
 */
export function delegationListRequestBody(): string {
  return JSON.stringify({ action: DELEGATION_LIST_ACTION });
}

/** 집이 돌려주는 한 줄. 🔴 **칸이 넷뿐이고 사람이 없다**(설계 C-9 ③). */
export type HouseDelegationEntry = {
  id: string;
  /** ISO 8601. 🔴 **시간대가 반드시 붙어 있다** — 아래 `epochOf` 가 그것을 요구한다. */
  startsAt: string;
  endsAt: string;
  /** 비어 있으면 그 집에서는 살아 있는 줄. */
  revokedAt: string | null;
};

/**
 * 🔴 **200 이 아닌 답은 전부 「못 쟀다」**다. 하나도 「집에 없다」로 세면 안 된다 —
 * 그 모양은 이 점검이 찾는 어긋남과 **글자 그대로 같아서** 거짓 경보가 아니라
 * **거짓 진짜**가 된다. 세 집이 「못 읽었을 때 빈 목록으로 답하지 않는다」를 제 시험으로
 * 못 박아 둔 것도 같은 까닭이다.
 */
export type DelegationListFailure =
  /** 망이 안 닿았다. 부르는 쪽이 `status: 0` 으로 들고 온다. */
  | "unreachable"
  /** 401 — 🔴 포털이 읽기 쓰임새를 굽지 않거나, 그 집이 읽기 갈래를 아직 안 올렸다. */
  | "invalid_token"
  /** 404 — 그 서버가 통합 로그인 모드가 아니다. 🔵 A/S 는 **mock 계정 모드**도 여기다. */
  | "not_enabled"
  /** 500(A/S · 휴가) · 503(🔴 재고관리만) — 표를 못 읽었다. 같은 뜻에 말이 두 벌이다. */
  | "storage_failed"
  /** 그 밖의 4xx·5xx. */
  | "http_error"
  /** 🔴 200 인데 모양이 다르다. 「모름」을 「없음」으로 접지 않는다. */
  | "bad_shape";

export type DelegationListAnswer =
  | { ok: true; entries: HouseDelegationEntry[]; truncated: boolean }
  | { ok: false; reason: DelegationListFailure };

/**
 * 한 줄이 규약대로인가. 🔴 **한 줄이라도 모양이 아니면 몸통 전체를 버린다.**
 *
 * 흘리고 나머지를 쓰면 흘린 줄이 그대로 「집에 없다」가 되는데, 그것이 이 점검이
 * 내릴 수 있는 **가장 비싼 오판**이다(③ — 더 위험한 쪽으로 읽힌다). 세는 도구가
 * 조용히 줄을 잃는 것보다 「못 쟀다」가 낫다.
 */
function readEntry(raw: unknown): HouseDelegationEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  if (typeof row.startsAt !== "string" || typeof row.endsAt !== "string") return null;
  if (row.revokedAt !== null && typeof row.revokedAt !== "string") return null;
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * 집의 답을 읽는다. 🔴 **던지지 않는다** — 한 집이 죽어도 나머지 둘은 재야 한다.
 *
 * 🔵 `readDelegationPushOutcome` 과 같은 처신이다: **200 인데 모양이 다르면 실패**로
 * 본다. 프록시가 끼어들어 빈 몸통을 주거나 저쪽이 규약을 바꾸면 「그 집에 무엇이 있는지
 * 모르는」 상태인데, 모르는 것을 빈 목록으로 읽으면 **그 집 위임이 통째로 어긋난 것으로
 * 보고된다.**
 */
export function readDelegationListReply(status: number, body: unknown): DelegationListAnswer {
  if (status === 0) return { ok: false, reason: "unreachable" };
  if (status === 401) return { ok: false, reason: "invalid_token" };
  if (status === 404) return { ok: false, reason: "not_enabled" };
  // 🔴 재고관리만 503 이다 — 그 집 통로가 인프라 실패를 503 한 낱말로만 답하도록 정해져
  //    있어서다(설계 C-9). 뜻은 500 과 같으므로 한 바구니에 넣는다.
  if (status === 500 || status === 503) return { ok: false, reason: "storage_failed" };
  if (status !== 200) return { ok: false, reason: "http_error" };

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "bad_shape" };
  }
  const shape = body as Record<string, unknown>;
  if (!Array.isArray(shape.delegations) || typeof shape.truncated !== "boolean") {
    return { ok: false, reason: "bad_shape" };
  }

  const entries: HouseDelegationEntry[] = [];
  for (const raw of shape.delegations) {
    const entry = readEntry(raw);
    if (entry === null) return { ok: false, reason: "bad_shape" };
    entries.push(entry);
  }
  return { ok: true, entries, truncated: shape.truncated };
}

/** 사람에게 보여 줄 한 마디. 🔵 상태 코드만으로는 무엇을 해야 할지 알 수 없다. */
export function describeDelegationListFailure(reason: DelegationListFailure): string {
  switch (reason) {
    case "unreachable":
      return "서버에 닿지 못했다 — 그 집이 떠 있지 않거나 launcher_url 이 가리키는 주소가 아니다";
    case "invalid_token":
      return "읽기 쓰임새를 거절했다 — 그 집이 읽기 갈래를 아직 안 올렸거나 쓰임새 글자가 갈렸다";
    case "not_enabled":
      return "통합 로그인 모드가 아니다 — A/S 는 mock 계정 모드도 여기다";
    case "storage_failed":
      return "그 집이 제 표를 못 읽었다 — 빈 목록 대신 실패로 답한 것이 규약대로다";
    case "http_error":
      return "200 이 아닌 답이 왔다";
    case "bad_shape":
      return "200 인데 몸통이 규약 모양이 아니다 — 줄을 흘리느니 통째로 버린다";
  }
}

/* ------------------------------------------------------------------ */
/* 맞대어 보기                                                          */
/* ------------------------------------------------------------------ */

/** 포털 쪽 한 줄. 🔴 **사람 번호는 여기까지 오지 않는다** — 들어오는 것은 아래 깃발뿐이다. */
export type PortalDelegationSnapshot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  revokedAt: Date | null;
  /**
   * 🔴 **이 집 기준**이다 — 위임자와 대리인이 **둘 다** 이 집에 들어갈 수 있는가.
   *
   * 거짓이면 그 집은 전파 때 `not_applicable` 로 끝났을 **까닭이 있는** 줄이고(위 ④),
   * 그래서 「포털에만 있다」가 설명된다. 🔴 참이어도 「어긋남」이라고 부르지 않는다 —
   * 접근 권한과 그 집 계정의 존재는 **완전히 같지 않다.**
   */
  bothHaveAccess: boolean;
};

/** 어느 칸이 어떻게 다른가. 🔵 값은 시각뿐이라 사람 자료가 없다. */
export type DelegationFieldDiff = {
  field: "startsAt" | "endsAt" | "revokedAt";
  portal: string | null;
  house: string | null;
};

export type DelegationMismatch = {
  id: string;
  diffs: DelegationFieldDiff[];
};

export type DelegationComparison = {
  /** ① 양쪽에 있고 값이 같다. */
  matched: string[];
  /** ② 🔴 양쪽에 있는데 값이 다르다 — **어긋남**이다. */
  mismatched: DelegationMismatch[];
  /**
   * 🔵 「포털은 안 거뒀는데 집은 거둬져 있다」 — **설계대로일 수 있다**(머리말).
   * 🔴 어긋남으로 단정하지 않는다. 그렇다고 통과도 아니라서 따로 센다.
   */
  revokedInHouseOnly: DelegationMismatch[];
  /** ③ 🔴 집에만 있다 — **더 위험한 쪽**이다. */
  houseOnly: string[];
  /** ④ 포털에만 있는데 **까닭이 있다** — 둘 중 하나가 그 집에 들어갈 수 없다. */
  explainedPortalOnly: string[];
  /** ④ 🔴 포털에만 있고 까닭을 못 찾았다 — 「어긋남」이 아니라 **「설명 안 되는 것」**. */
  unexplainedPortalOnly: string[];
  /** 🔴 집 답이 잘렸다 — 안 온 줄을 「집에 없다」로 읽으면 안 된다. */
  unmeasuredByTruncation: string[];
  /** 🔴 집이 보낸 시각 글자를 못 읽었다(시간대가 없거나 ISO 가 아니다). */
  unreadable: string[];
};

/**
 * 시각 글자를 순간으로. 🔴 **시간대가 없으면 거절한다.**
 *
 * `Date.parse("2026-11-17T00:00:00")` 은 **읽는 기계의 지역 시각**이 된다. 개발
 * PC(KST)와 NAS(UTC)에서 아홉 시간 다른 순간이 되는데 오류는 한 줄도 안 나고, 이
 * 점검에서는 그것이 **멀쩡한 줄을 어긋남으로 찍는** 모양으로 나타난다. 전파가 나갈 때
 * 요구하는 것과 같은 규칙이다(`delegation-push.ts` 머리말 2번).
 */
function epochOf(iso: string): number | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 한 집과 맞대어 본다.
 *
 * 🔴 **`truncated` 면 「포털에만 있다」를 한 줄도 말하지 않는다.** 집이 `id` 오름차순으로
 * 자른다고 적어 두었으니 「받은 마지막 번호보다 작은 줄은 확실히 없다」고 좁힐 수도 있다.
 * 🔵 **그 좁히기를 일부러 안 한다** — 차례는 그 집의 약속일 뿐 이쪽에서 잴 수 없고, 그
 * 약속에 기대어 내리는 판정이 하필 **가장 비싼 오판**(③ 쪽으로 읽히는 「집에 없다」)이다.
 * 상한은 2000 이고 이 표는 해에 수십 줄 자라므로, 좁혀서 얻을 것이 사실상 없다.
 */
export function compareDelegations(params: {
  portal: readonly PortalDelegationSnapshot[];
  house: readonly HouseDelegationEntry[];
  truncated: boolean;
}): DelegationComparison {
  const result: DelegationComparison = {
    matched: [],
    mismatched: [],
    revokedInHouseOnly: [],
    houseOnly: [],
    explainedPortalOnly: [],
    unexplainedPortalOnly: [],
    unmeasuredByTruncation: [],
    unreadable: [],
  };

  const remaining = new Map(params.house.map((entry) => [entry.id, entry]));

  for (const row of params.portal) {
    const entry = remaining.get(row.id);
    if (entry === undefined) {
      if (params.truncated) result.unmeasuredByTruncation.push(row.id);
      else if (!row.bothHaveAccess) result.explainedPortalOnly.push(row.id);
      else result.unexplainedPortalOnly.push(row.id);
      continue;
    }
    remaining.delete(row.id);

    const starts = epochOf(entry.startsAt);
    const ends = epochOf(entry.endsAt);
    const revoked = entry.revokedAt === null ? null : epochOf(entry.revokedAt);
    if (starts === null || ends === null || (entry.revokedAt !== null && revoked === null)) {
      result.unreadable.push(row.id);
      continue;
    }

    const diffs: DelegationFieldDiff[] = [];
    if (row.startsAt.getTime() !== starts) {
      diffs.push({ field: "startsAt", portal: row.startsAt.toISOString(), house: entry.startsAt });
    }
    if (row.endsAt.getTime() !== ends) {
      diffs.push({ field: "endsAt", portal: row.endsAt.toISOString(), house: entry.endsAt });
    }
    if ((row.revokedAt === null ? null : row.revokedAt.getTime()) !== revoked) {
      diffs.push({
        field: "revokedAt",
        portal: row.revokedAt === null ? null : row.revokedAt.toISOString(),
        house: entry.revokedAt,
      });
    }

    if (diffs.length === 0) {
      result.matched.push(row.id);
      continue;
    }

    // 🔵 **다른 칸이 한 칸도 없을 때만** 설계대로인 쪽으로 센다. 기간까지 갈렸다면 그것은
    //    B-15 와 같은 종류의 어긋남이고, 철회 방향이 겹쳤다고 눈감아 줄 일이 아니다.
    // 🔴 **차례로 찾지 않는다**(`diffs[0]` 이 아니다). 위에서 담는 차례가 바뀌면 그 순간
    //    조건이 말없이 느슨해지는데, 담는 차례는 이 판정과 아무 상관이 없는 값이다 —
    //    일부러 깨뜨려 보고서야 드러났다(2026-11-17).
    const revokedDiff = diffs.find((diff) => diff.field === "revokedAt");
    const onlyRevokedInHouse =
      diffs.length === 1 && revokedDiff !== undefined && revokedDiff.portal === null;
    if (onlyRevokedInHouse) result.revokedInHouseOnly.push({ id: row.id, diffs });
    else result.mismatched.push({ id: row.id, diffs });
  }

  // 🔴 잘렸든 아니든 **집에 있는 줄은 확실히 있다** — 여기는 상한과 무관하게 판정한다.
  result.houseOnly.push(...remaining.keys());
  return result;
}

/** 🔴 **어긋남**으로 셀 것 — ② 와 ③ 뿐이다. 나머지는 통과도 어긋남도 아니다. */
export function delegationSyncFindings(comparison: DelegationComparison): number {
  return comparison.mismatched.length + comparison.houseOnly.length;
}

/**
 * 🔴 **못 쟀다**로 셀 것. 「설명 안 되는 것」이 여기 들어간다 — ✓ 로 접으면 도구가
 * 있으나 마나 하고, ✗ 로 접으면 **정상인 줄을 사고로 보고**한다(개발 DB 의 일곱 줄처럼).
 * 🔵 「포털은 안 거뒀는데 집은 거둬졌다」도 여기다 — 설계대로일 **수** 있을 뿐이라
 * 사람이 한 번 봐야 한다.
 */
export function delegationSyncUnmeasured(comparison: DelegationComparison): number {
  return (
    comparison.unexplainedPortalOnly.length +
    comparison.unmeasuredByTruncation.length +
    comparison.unreadable.length +
    comparison.revokedInHouseOnly.length
  );
}
