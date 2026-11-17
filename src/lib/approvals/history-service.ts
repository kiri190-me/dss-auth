import "server-only";
import { getIssuer } from "@/lib/config/env";
import { getSigningKey } from "@/lib/crypto/keys";
import { listAccessibleClients } from "@/lib/db/queries/clients";
import { signPortalServiceToken } from "@/lib/oidc/service-token";
import type { SignApprovalToken } from "./gather";
import {
  gatherApprovalHistory,
  type PortalApprovalHistory,
  type UnreachableHistorySource,
} from "./history-gather";
import type { ApprovalHistoryPeriod } from "./history-period";
import { toApprovalHistorySources } from "./sources";

/**
 * ============================================================================
 * 승인함에 내줄 결재 내역의 **배선** — 바깥 둘(DB · 서명 키)을 만지는 유일한 곳
 * ============================================================================
 * 흐름과 판단은 history-gather.ts 에 있고, 여기는 그 인자들에 진짜 구현을 끼운다.
 * 결재함 쪽 screen-service.ts 와 **같은 자리이고 같은 틀**이다.
 *
 * 🔴 **캐시가 하나도 없다.** 사람이 기간을 바꿀 때마다 셋에 새로 묻는다. 기간이
 * 열쇠에 안 들어간 캐시는 「11월을 물었는데 10월 답이 온다」가 되고, 기간까지 넣은
 * 캐시는 고를 수 있는 기간이 무한해 거의 맞지 않는다. 치르는 값은 왕복 한 번
 * (최대 1.5초, 셋이 동시)뿐이다.
 *
 * 🔴 **종의 창구를 부르지 않는다.** 결재함 쪽과 같은 까닭이다 — 지움(✕)·확인(✓)은
 * 「종에서 그만 보겠다」지 「그 결재가 없던 일이 됐다」가 아니다. 내역에서 그것을
 * 거르면 사람이 분명히 한 결재가 제 기록에서 사라진다.
 * ============================================================================
 */

/**
 * 이 사람의 이름으로 서명하는 함수.
 *
 * 🔴 subject 를 **여기서 한 번 닫는다.** 아래로 내려가는 함수들은 「누구」를 다시
 * 정할 수 없다 — 한 번 도는 동안 사람이 섞이는 실수를 타입 수준에서 막는다
 * (screen-service.ts · notifications/site-service.ts 의 `signerFor` 와 같은 모양).
 *
 * 🔵 여덟 줄을 또 적었다. 저쪽 것을 꺼내 쓰지 않은 까닭도 그 파일에 적힌 그대로다.
 */
function signerFor(subject: string): SignApprovalToken {
  return async ({ audience, purpose }) => {
    const { key, kid } = await getSigningKey();
    return signPortalServiceToken({
      issuer: getIssuer(),
      audience,
      subject,
      purpose,
      key,
      kid,
    });
  };
}

/**
 * 승인함에 내줄 「이 사람이 이 기간에 한 결재」 전부.
 *
 * 🔴 **「이 사람이 들어갈 수 있는 시스템」에만 묻는다** — 앱 런처 타일 · 서비스
 * 메뉴바 · 통합 종 · 결재함과 **같은 판정 하나**다(queries/clients.ts 의
 * `listAccessibleClients`). 못 들어가는 시스템에 물으면 그 시스템에 「이 사람이
 * 존재한다」를 알리는 꼴이 된다.
 *
 * 🔵 권한을 잃은 시스템의 **옛 결재 행적도 그만큼 안 보인다.** 알고 두는 선택이다 —
 * 지금 들어갈 수 없는 시스템에 그 사람의 자료를 물어볼 자격이 포털에 없고, 그
 * 울타리를 내역에서만 푸는 것이 더 나쁘다.
 *
 * 🔴 **던질 수 있다** — DB 가 죽은 경우다. 라우트가 503 으로 받는다. 모으는 동안의
 * 실패(죽음 · 느림 · 토큰 거절)는 던지지 않고 `sources` 로 돌아온다.
 */
export async function getPortalApprovalHistory(params: {
  userId: string;
  period: ApprovalHistoryPeriod;
}): Promise<PortalApprovalHistory> {
  const tiles = await listAccessibleClients(params.userId);
  const { sources, skipped } = toApprovalHistorySources(tiles);

  // 🔴 **이름을 함께 올린다.** 이름 없이 올리면 「무엇을 못 읽었는지」가 화면에 아예
  //    안 뜬다(history-gather.ts 의 UnreachableHistorySource). 이름은 방금 읽은
  //    타일에 이미 들어 있다.
  const nameOf = new Map(tiles.map((tile) => [tile.clientId, tile.name]));
  const unreachable: UnreachableHistorySource[] = skipped.map((row) => ({
    clientId: row.clientId,
    // 타일에서 온 목록이라 이름이 없을 수 없다. 그래도 빈 이름을 올려 줄이 통째로
    // 사라지는 것보다는 client_id 라도 적어 주는 편이 낫다.
    name: nameOf.get(row.clientId) ?? row.clientId,
    reason: row.reason,
  }));

  for (const row of skipped) {
    // 화면에도 뜨지만 로그에도 남긴다 — 고치는 사람은 화면이 아니라 로그를 본다.
    console.error(
      `[approval-history] ${row.clientId} 의 launcher_url 이 ${row.reason} 이라 물어볼 수 없습니다. npm run client:register 로 등록하세요.`
    );
  }

  return gatherApprovalHistory({
    sources,
    unreachable,
    period: params.period,
    signToken: signerFor(params.userId),
  });
}
