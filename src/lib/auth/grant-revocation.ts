/**
 * ============================================================================
 * 시스템별 접근 권한을 **회수**했을 때 그 사람의 세션을 어떻게 끊는가 — 판정 전부
 * ============================================================================
 * 계정 정지(admin-users.ts의 suspendUser)에는 이 장치가 처음부터 있었다.
 * 그 함수의 주석이 까닭을 이미 적어 두었다:
 *
 *   "정지는 '지금부터 못 들어온다'만으로는 부족하다. 이미 들어가 있는 사람은
 *    자기 세션이 만료될 때까지 계속 일할 수 있다."
 *
 * 🔴 **권한 회수에는 그것이 빠져 있었다.** 그런데 A/S 쪽에서 계정을 지우는
 * 것은 차단이 아니다 — 같은 통합 로그인으로 다시 들어오면 같은 sso_subject로
 * 계정이 되살아난다. 그래서 "저 사람을 저 시스템에서 빼라"의 유일한 수단이
 * 포털의 권한 회수이고, 그것이 이미 열려 있는 세션을 그대로 두면 회수가
 * 실제로는 회수가 아니다.
 *
 * ── 🔴 두 갈래 중 (가)를 골랐다 ──────────────────────────────────────────────
 *
 * (가) **그 시스템에만 알린다** ← 고른 쪽
 *      포털 세션은 살려 두고, 권한을 뺀 그 시스템에만 백채널 로그아웃을
 *      보낸다. 그 사람은 다른 시스템에서 하던 일을 계속한다.
 *
 * (나) 포털 세션을 전부 끊는다 — **고르지 않았다.** 대가가 둘이다:
 *      1. 권한과 무관한 다른 시스템의 일까지 끊긴다. 회수는 "저 시스템 하나에
 *         못 들어간다"는 뜻인데, 벌은 전 시스템에 내려진다. 정지와 회수의
 *         구분이 사라진다.
 *      2. 🔴 **정작 그 시스템은 통보를 못 받는다.** 정지 쪽이 쓰는
 *         notifyBackchannelLogout은 "그 사람이 들어갈 수 있는 시스템"을 찾아
 *         보내는데(backchannel-logout.ts의 findTargets), 권한을 방금 뺐으므로
 *         그 시스템은 바로 그 목록에서 빠진 곳이다. 정지 쪽 코드를 그대로
 *         베껴 오면 **다른 시스템은 다 끊기고 회수한 시스템만 안 끊기는**
 *         정반대 결과가 된다.
 *
 * (가)가 치르는 대가도 적어 둔다: 포털 세션이 살아 있으므로 그 사람의 브라우저는
 * 계속 로그인 상태다. 그래도 회수한 시스템에는 다시 못 들어간다 — 앱 런처에서
 * 타일이 사라지고, 주소를 직접 쳐도 인가 단계에서 hasClientAccess가 막는다.
 *
 * ── 왜 DB와 통신을 인자로 받는가 ────────────────────────────────────────────
 * 이 파일의 값어치는 **누구의 세션을, 어느 시스템에서만 끊는가** 하나에 달려
 * 있다. 액션 안에 두면 DB와 서명 키가 붙어 있어 시험이 그 판정을 돌려 볼 수
 * 없다(site-feed.ts·gather.ts와 같은 이유). 액션은 이것을 진짜 함수로 채우는
 * 껍데기다.
 * ============================================================================
 */

/** 권한을 회수한 그 시스템. 판정에 필요한 칸만 받는다. */
export type RevokedClient = {
  /** 공개 client_id. 로그아웃 토큰의 aud가 된다. */
  clientId: string;
  /**
   * false면 user_client_grants를 보지 않고 전 직원을 들여보내는 시스템이다.
   * hasClientAccess(oidc-clients.ts)가 그 칸을 첫 줄에서 본다.
   */
  requiresGrant: boolean;
  isActive: boolean;
  /** 비어 있으면 통보를 받을 준비가 안 된 시스템이다(clients.ts 주석 참조). */
  backchannelLogoutUri: string | null;
};

/**
 * 통보를 보내지 않은 까닭. 감사 기록에 그대로 들어간다 — "권한은 뺐는데 세션은
 * 그대로다"를 나중에 누군가 물어볼 때, 그것이 정책이었는지 사고였는지 구분되어야
 * 한다.
 */
export type SessionCutSkipReason =
  /**
   * 🔴 전 직원 공개 시스템(requiresGrant=false)이다. 부여 행을 지워도 그 사람은
   * 여전히 들어간다 — 그 시스템은 부여 행을 보지 않기 때문이다. 그래서 세션을
   * 끊는 것이 **아무 뜻이 없다.** 끊으면 그 사람은 튕겨 나갔다가 곧바로 다시
   * 들어오고, 관리자는 "막았다"고 오해한다. 여기서 지워진 것은 접근 권한이
   * 아니라 역할뿐이고, 역할 변경은 원래 다음 로그인부터 반영된다.
   */
  | "NO_GRANT_CHECK"
  /**
   * 비활성 시스템이다. 포털 전체가 비활성 클라이언트를 "없는 것"으로 다루고
   * (getActiveClient·findTargets), 정지 쪽도 통보하지 않는다. 여기만 다르게
   * 굴면 판정이 두 벌이 된다.
   */
  | "CLIENT_INACTIVE"
  /** 통보 주소가 등록되지 않았다. 보낼 곳이 없다. */
  | "NO_BACKCHANNEL_URI";

export type SessionCutOutcome = {
  /** 통보를 보내려 했는가. */
  cut: boolean;
  /** 보내지 않았다면 왜. 보냈으면 null. */
  skipped: SessionCutSkipReason | null;
  /** 보냈는데 그쪽이 받지 못했는가. cut이 false면 항상 false다. */
  failed: boolean;
};

/**
 * 통보를 보낼지, 보내지 않는다면 왜인지. null이면 보낸다.
 *
 * 순서에 뜻이 있다: requiresGrant를 맨 먼저 본다. 전 직원 공개 시스템은
 * 통보 주소가 있든 없든 애초에 끊을 이유가 없다.
 */
export function decideSessionCut(client: RevokedClient): SessionCutSkipReason | null {
  if (!client.requiresGrant) return "NO_GRANT_CHECK";
  if (!client.isActive) return "CLIENT_INACTIVE";
  if (!client.backchannelLogoutUri) return "NO_BACKCHANNEL_URI";
  return null;
}

/** 감사 기록 한 줄. 진짜 appendAuditLog가 그대로 받는 꼴이다. */
export type SessionCutAudit = {
  actorUserId: string;
  actionType: "SESSION_REVOKED";
  targetEntity: string;
  targetRecordId: string;
  clientId: string;
  newValue: {
    reason: "ACCESS_REVOKED";
    /** 🔴 누구의 세션을 끊었는가. 이 칸이 없으면 기록이 쓸모없다. */
    userId: string;
    displayName: string;
    cut: boolean;
    skipped: SessionCutSkipReason | null;
    backchannelFailed: boolean;
    note?: string;
  };
};

export type GrantRevocationDeps = {
  /**
   * 🔴 시스템 **하나**에만 "이 사람 세션 끊어라"를 보낸다. 받았으면 true.
   *
   * 던지지 않는 것이 계약이지만, 아래에서 한 번 더 감싼다 — 통보 실패가 이미
   * 끝난 권한 회수를 되돌리거나 관리자 화면을 500으로 만들면 안 된다.
   */
  notifyLogout(params: {
    userId: string;
    clientId: string;
    logoutUri: string;
  }): Promise<boolean>;
  /** 감사 기록. 실패해도 던지지 않는 것이 계약이다(audit.ts 참조). */
  audit(entry: SessionCutAudit): Promise<void>;
};

/**
 * 권한 회수 직후에 그 시스템의 세션을 끊는다.
 *
 * 🔴 **부여 행을 지운 뒤에 부른다.** 순서를 뒤집으면 통보와 삭제 사이에 그
 * 사람이 다시 로그인해 세션을 새로 만들 수 있다.
 *
 * 🔴 **회수할 때만 부른다.** 권한을 주거나 역할만 바꾸는 길에서는 부르지
 * 않는다 — 주면서 끊으면 방금 권한을 받은 사람이 튕겨 나가고, 역할 변경은
 * 원래 다음 로그인부터 반영된다고 화면이 안내한다.
 */
export async function cutSessionsForRevokedGrant(
  params: {
    /** 🔴 권한을 빼앗긴 그 사람 하나. 다른 누구의 세션도 건드리지 않는다. */
    userId: string;
    displayName: string;
    /** 회수를 실행한 포털 관리자. */
    actorUserId: string;
    /** 방금 지워진 user_client_grants 행의 id. 기록을 그 행에 묶어 둔다. */
    grantRecordId: string;
    client: RevokedClient;
  },
  deps: GrantRevocationDeps
): Promise<SessionCutOutcome> {
  const skipped = decideSessionCut(params.client);

  // null이 아님은 decideSessionCut이 이미 확인했다. 그래도 한 번 더 보는
  // 이유는 형 단언(as)을 쓰지 않기 위해서다 — 단언은 나중에 판정이 바뀌면
  // 조용히 틀린 값을 통과시킨다.
  const logoutUri = params.client.backchannelLogoutUri;

  let failed = false;
  if (!skipped && logoutUri) {
    try {
      const ok = await deps.notifyLogout({
        userId: params.userId,
        clientId: params.client.clientId,
        logoutUri,
      });
      failed = !ok;
    } catch {
      failed = true;
    }
  }

  // 정지 쪽(notifyBackchannelLogout)과 같은 꼴로 남긴다: SESSION_REVOKED에
  // reason과 backchannelFailed. 다른 점은 **성공도 남긴다**는 것이다 —
  // 권한 회수는 "세션까지 끊었는가"가 곧 회수의 성패라, 실패만 기록하면
  // 성공한 회수는 흔적이 없어 나중에 확인할 수 없다.
  //
  // targetEntity를 sso_sessions가 아니라 user_client_grants로 두는 이유:
  // 여기서 끊은 것은 세션 한 개가 아니라 "그 사람이 그 시스템에서 갖는 세션
  // 전부"라 지목할 세션 id가 없다. 지워진 부여 행에 묶어 두면 GRANT_REMOVED와
  // 같은 행을 가리켜 두 줄이 한 사건으로 읽힌다.
  try {
    await deps.audit({
      actorUserId: params.actorUserId,
      actionType: "SESSION_REVOKED",
      targetEntity: "user_client_grants",
      targetRecordId: params.grantRecordId,
      clientId: params.client.clientId,
      newValue: {
        reason: "ACCESS_REVOKED",
        userId: params.userId,
        displayName: params.displayName,
        cut: !skipped,
        skipped,
        backchannelFailed: failed,
        ...(skipped || failed ? { note: SESSION_CUT_NOTES[skipped ?? "NOTIFY_FAILED"] } : {}),
      },
    });
  } catch {
    // 감사 기록 실패가 권한 회수를 실패시키지 않는다(audit.ts와 같은 판단).
  }

  return { cut: !skipped, skipped, failed };
}

/** 감사 기록을 읽는 사람이 바로 알아볼 수 있게, 뜻을 한 줄로 함께 적는다. */
const SESSION_CUT_NOTES: Record<SessionCutSkipReason | "NOTIFY_FAILED", string> = {
  NO_GRANT_CHECK:
    "전 직원 공개 시스템이라 부여 행을 지워도 접근은 그대로입니다. 막으려면 계정을 정지하세요.",
  CLIENT_INACTIVE: "비활성 시스템이라 통보하지 않았습니다.",
  NO_BACKCHANNEL_URI:
    "통보 주소가 등록되지 않아 그쪽 세션은 만료될 때까지 유효합니다.",
  NOTIFY_FAILED: "통보를 받지 못한 시스템의 세션은 만료될 때까지 유효합니다.",
};

/**
 * 관리자 화면에 덧붙일 뒷말.
 *
 * 🔴 실제로 일어난 일을 숨기지 않는다. "권한을 회수했습니다"만 보여주면,
 * 전 직원 공개 시스템에서도·통보가 실패해도 관리자는 막혔다고 믿는다. 급해서
 * 회수한 것이었다면 그 믿음이 곧 사고다.
 */
export function sessionCutNotice(outcome: SessionCutOutcome): string {
  if (outcome.cut) {
    return outcome.failed
      ? " 다만 그 시스템에 통보하지 못했습니다 — 그쪽 세션은 만료될 때까지 살아 있습니다."
      : " 그 시스템에 열려 있던 세션도 끊었습니다.";
  }

  switch (outcome.skipped) {
    case "NO_GRANT_CHECK":
      return " 다만 전 직원 공개 시스템이라 접근은 그대로입니다 — 막으려면 계정을 정지하세요.";
    case "CLIENT_INACTIVE":
      return " 비활성 시스템이라 세션 통보는 보내지 않았습니다.";
    case "NO_BACKCHANNEL_URI":
      return " 다만 그 시스템에는 통보 주소가 없어 그쪽 세션은 만료될 때까지 살아 있습니다.";
    default:
      return "";
  }
}
