/**
 * 로그인할 때 함께 나가는 「이 사람이 쓸 수 있는 서비스 목록」.
 *
 * 무엇에 쓰나: 각 시스템(A/S · 계측기 …) 위쪽에 붙을 **서비스 전환
 * 메뉴바**의 재료다. 직원은 하루에도 시스템을 여러 번 옮겨 다니는데, 지금은
 * 그때마다 포털(/apps)로 돌아가야 한다. 메뉴바가 있으면 한 번에 건너간다.
 *
 * 왜 포털이 내주나(= 왜 각 시스템이 제 목록을 갖지 않나): 누가 어느
 * 시스템에 들어갈 수 있는지는 포털만 안다. 각 시스템이 목록을 제 설정에
 * 적어 두면 (1) 권한이 회수된 사람에게도 메뉴가 그대로 보이고, (2) 주소가
 * 바뀔 때 고칠 곳이 시스템 수만큼 늘어난다 — docs/주소.md가 없애려던 바로
 * 그 모양이다.
 *
 * server-only를 붙이지 않는다 — 순수 함수이고, 무엇이 실리고 무엇이
 * 빠지는지를 테스트로 못 박아야 한다(client-order.ts와 같은 이유).
 */
import type { ClientTile } from "@/lib/db/queries/clients";

/**
 * ID 토큰에 실리는 클레임 이름.
 *
 * 표준 클레임이 아니므로 이름이 겹치지 않게 접두사를 붙인다(RFC 7519 §4.3의
 * private claim 권고). "services"처럼 흔한 낱말은 나중에 다른 규격이
 * 가져갈 수 있고, 그때 같은 자리에 다른 뜻의 값이 들어오면 받는 쪽이
 * 조용히 엉뚱한 것을 그린다.
 *
 * 먼저 있는 role은 접두사가 없는데, 그건 A/S 시스템이 이미 읽고 있는
 * 이름이라 지금 바꾸면 그쪽 로그인이 깨진다. 새로 만드는 것부터 규칙을
 * 지킨다.
 */
export const SERVICE_MENU_CLAIM = "dss_services";

/**
 * 메뉴바 한 칸. **그리는 데 필요한 최소한만** 담는다.
 *
 * 토큰은 로그인할 때마다 통째로 서명되어 오가는 값이고, 한 칸이 커지면
 * 시스템 수만큼 곱해져 커진다. description처럼 메뉴바가 그리지 않는 값은
 * 담지 않는다 — 나중에 그 이상이 필요해지면 토큰을 불리는 대신 포털에
 * 통로(조회 주소)를 따로 내는 쪽이 맞다.
 */
export type ServiceMenuEntry = {
  /**
   * clients.client_id. 받는 쪽이 ID 토큰의 aud와 견주어 「지금 여기」를
   * 눌린 상태로 그릴 수 있게 하는 값이라, 이름이 아니라 이 식별자를 싣는다.
   */
  id: string;
  /** 사람에게 보이는 이름. 포털 타일에 뜨는 것과 같은 이름이어야 한다. */
  name: string;
  /**
   * 눌렀을 때 갈 주소. listAccessibleClients가 {lan}을 이 기계의 주소로
   * 이미 펼친 뒤의 값이다(docs/주소.md).
   */
  url: string;
  /**
   * 글자 아이콘(이모지). 없으면 **키 자체가 없다** — 받는 쪽이 "안 왔다"와
   * "빈 값이 왔다"를 구분해 제 기본값을 쓸 수 있어야 한다(id-token의
   * email·role과 같은 규칙).
   */
  icon?: string;
};

/**
 * 아이콘 글자 수 상한.
 *
 * launcherIcon은 /apps 타일이 글자로 그리는 값(이모지)이지만, 등록할 때
 * 무엇을 넣는지 막는 장치가 없다 — scripts/register-client.ts는 받은
 * 문자열을 그대로 넣는다. 누가 data: URI 같은 그림을 넣으면 **모든 사람의
 * 모든 로그인 토큰이** 그만큼 부푼다.
 *
 * 그래서 길면 아이콘만 뺀다. 로그인을 막지 않는 이유: 메뉴바는 아이콘 없이도
 * 그려지고, 등록값 하나의 실수로 로그인이 안 되는 편이 훨씬 나쁘다.
 *
 * 16: 국기나 가족 이모지처럼 코드 포인트가 ZWJ로 여럿 묶인 것도 이 안에
 * 들어온다.
 */
const MAX_ICON_LENGTH = 16;

/**
 * 권한대로 걸러진 시스템 목록(listAccessibleClients의 답)을 메뉴바 재료로
 * 옮긴다.
 *
 * ⚠️ **여기서 권한을 판정하지 않는다.** 받은 목록에 없는 것을 더하지 않고,
 * 누가 들어갈 수 있는지 다시 따지지도 않는다. 판정이 두 벌이 되면 포털
 * 타일과 메뉴바가 서로 다른 말을 하게 되고, 둘 중 어느 쪽이 맞는지 아무도
 * 모르게 된다. 입력 타입을 ClientTile로 못 박아 둔 것도 그래서다 — 저쪽
 * 조회가 바뀌면 여기서 컴파일이 깨진다.
 *
 * 빼는 것은 딱 하나, **갈 주소가 없는 시스템**이다. 메뉴바는 눌러서
 * 건너가는 것이라 주소 없는 칸은 그릴 수 없다(포털 타일은 아이콘과 설명을
 * 보여줄 자리가 있어 주소가 없어도 뜻이 있다 — 그래서 /apps와 칸 수가
 * 다를 수 있다. 권한이 달라서가 아니다).
 *
 * 차례는 받은 그대로 둔다. listAccessibleClients가 이미 sort_order로 줄을
 * 세웠으니 배열 순서가 곧 표시 순서다 — 순서 값을 따로 실을 필요가 없다.
 *
 * **받는 시스템 자신도 남긴다.** 이 함수는 aud를 아예 받지 않는다. 메뉴바는
 * 「지금 여기」를 눌린 상태로 보여야 자기가 어디에 있는지 알 수 있고,
 * 그러려면 자기 칸이 목록에 있어야 한다. 포털이 빼 버리면 각 시스템이 제
 * 이름과 주소를 스스로 적어 되살려야 하는데, 그 순간 주소가 다시 시스템마다
 * 흩어진다. 받는 쪽은 자기 client_id를 aud로 이미 알고 있으니, 어느 칸이
 * 자기인지 고르는 일은 그쪽에서 하면 된다.
 */
export function toServiceMenu(
  tiles: readonly ClientTile[]
): ServiceMenuEntry[] {
  const menu: ServiceMenuEntry[] = [];

  for (const tile of tiles) {
    if (!tile.launcherUrl) continue;

    const entry: ServiceMenuEntry = {
      id: tile.clientId,
      name: tile.name,
      url: tile.launcherUrl,
    };
    if (tile.launcherIcon && tile.launcherIcon.length <= MAX_ICON_LENGTH) {
      entry.icon = tile.launcherIcon;
    }
    menu.push(entry);
  }

  return menu;
}
