"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPortalAdmin } from "@/lib/auth/portal-admin";
import { saveKindPurposes } from "@/lib/db/mutations/notification-kind-purposes";
import { listKindPurposes } from "@/lib/db/queries/notification-kind-purposes";
import { diffSubmittedPurposes } from "@/lib/notifications/purposes";
import {
  getNotificationSettings,
  saveNotificationSettings,
} from "@/lib/notifications/service";
import { diffSubmittedSettings } from "@/lib/notifications/settings-form";

/**
 * ============================================================================
 * 알림 설정 저장 — 바뀐 줄만, 그 시스템으로. 분류만 포털에.
 * ============================================================================
 * 🔴 **사용·역할은 포털이 갖지 않는다**(설계서 D-5). 표를 받아 「무엇이
 * 달라졌나」를 계산해 그 시스템으로 넘기고, 돌아온 답을 사람이 읽을 한 줄로
 * 옮기는 것이 그 몫의 전부다.
 *
 * ── 🔴 딱 하나, **분류**(정보 확인용·승인용)는 포털 DB 에 적는다 ───────────
 * 2026-10-21 에 더했다. 알림 통로를 연 다섯 가운데 설정을 실제로 바꿀 수 있는
 * 곳은 A/S 하나뿐이고, 나머지 넷은 저장을 403 으로 거절한다 — 분류까지 저쪽에
 * 맡기면 넷은 영영 고칠 수 없다(db/schema/notification-kind-purposes.ts).
 *
 * 🔴 **그 넷에서도 403 이 뜨지 않는 까닭은 순서가 아니라 `changes.length` 다.**
 * 잠긴 시스템은 모든 칸이 disabled 라 폼에 실리지 않고, 그래서 시스템 쪽 변경이
 * 늘 0 이다. 0 이면 **아예 보내지 않는다.** 아래에서 분류를 먼저 저장하고 시스템
 * 전송은 `changes.length > 0` 일 때만 하는 그 모양을 뒤집지 마라.
 *
 * ── 🔴 둘 중 하나가 실패하면 ──────────────────────────────────────────────
 * **분류(포털 DB)를 먼저, 시스템 전송을 뒤에** 한다. 포털 DB 는 거의 실패하지
 * 않고, 실패하면 **아직 아무것도 보내지 않은 상태**라 「하나도 저장되지 않았다」가
 * 참이다. 반대로 두면 저쪽에 보낸 뒤 포털 쓰기가 깨져 「반만 저장됨」이 되는데,
 * 그 상태는 사람에게 설명할 말이 없다.
 *
 * 🔴 뒤의 전송이 실패하면 **그 실패를 그대로 알리되 「분류는 저장했다」도 함께
 * 말한다.** 실패를 성공으로 보여 주지 않는다는 아래 규칙과, 이미 저장된 것을
 * 숨기지 않는다는 것은 같은 말이다 — 사람이 다시 눌렀을 때 분류가 「바뀐 것이
 * 없다」로 나오는 까닭이 그것이다.
 *
 * ── 왜 저장 직전에 한 번 더 물어보는가 ────────────────────────────────────
 * 폼은 「사람이 원하는 상태」만 실어 온다. 무엇이 **바뀌었는지**를 알려면 지금
 * 값이 있어야 하는데, 화면이 그려질 때의 값을 숨은 칸에 담아 되받으면 두 가지가
 * 나빠진다: (1) 화면을 열어 둔 사이 저쪽에서 달라진 줄까지 되돌려 놓게 되고,
 * (2) 그 숨은 값이 곧 포털이 들고 있는 설정 사본이 된다. 그래서 다시 묻는다 —
 * A/S 실측 13ms 짜리 조회 하나다.
 *
 * 덤으로 하나 더 얻는다: 저쪽이 죽어 있으면 **쓰기 전에** 알게 된다.
 *
 * ── 권한 ──────────────────────────────────────────────────────────────────
 * 두 겹이다. 이 액션은 화면을 거치지 않고 직접 불릴 수 있으므로 포털 관리자인지
 * 스스로 본다(portal-admin.ts 가 화면 가드와 액션 가드를 따로 두는 그 이유).
 * 그리고 **그 시스템의 관리자인지는 그 시스템이 본다** — 포털 관리자라는 것이
 * A/S 관리자라는 뜻은 아니다. 그쪽 답이 403 이면 아래에서 그대로 적어 준다.
 * ============================================================================
 */

const PATH = "/admin/notifications";

function resultUrl(kind: "ok" | "error", message: string): string {
  return `${PATH}?${kind}=${encodeURIComponent(message)}`;
}

/** 🔴 redirect 는 던진다 — 부르는 쪽에서 try 로 감싸면 안 된다. */
function fail(reason: string): never {
  redirect(resultUrl("error", reason));
}

function done(notice: string): never {
  revalidatePath(PATH);
  redirect(resultUrl("ok", notice));
}

export async function saveSystemNotificationSettings(formData: FormData) {
  const admin = await assertPortalAdmin();

  const clientId = formData.get("clientId");
  if (typeof clientId !== "string" || clientId === "") {
    fail("어느 시스템의 설정인지 알 수 없습니다.");
  }

  const overview = await getNotificationSettings(admin.userId);
  const system = overview.systems.find((row) => row.clientId === clientId);

  // 목록에 없다 = 이 사람이 들어갈 수 없는 시스템이거나, 알림 통로가 없는
  // 시스템이다. service.ts 가 같은 판정을 다시 하지만 여기서 멈추는 편이
  // 사람에게 보여 줄 말이 분명하다.
  if (!system) fail("이 시스템의 알림 설정을 바꿀 수 없습니다.");
  if (system.status === "forbidden") fail(`${system.name} — ${system.message}`);
  if (system.status === "unavailable") {
    // 🔴 못 물어본 채로 보내지 않는다. 지금 값을 모르면 「바뀐 것」을 고를 수
    // 없고, 모르는 채로 표 전체를 밀어 넣으면 남이 바꿔 둔 줄을 되돌린다.
    fail(`${system.name} — ${system.message} 저장하지 않았습니다.`);
  }

  const changes = diffSubmittedSettings({
    form: formData,
    roles: system.roles,
    kinds: system.kinds,
  });

  // 분류는 포털이 가진 값이라 저쪽에 묻지 않는다. 지금 값이 있어야 「달라진
  // 것」을 고를 수 있는 것은 위와 같고, 묻는 곳만 다르다.
  const purposeChanges = diffSubmittedPurposes({
    form: formData,
    kinds: system.kinds,
    stored: await listKindPurposes(clientId),
  });

  const purposeCount = purposeChanges.length;
  if (changes.length === 0 && purposeCount === 0) {
    done(`${system.name} — 바뀐 것이 없습니다.`);
  }

  // 🔴 분류가 먼저다(이 파일 머리말). 여기서 깨지면 저쪽에는 아직 아무것도
  // 보내지 않았으므로 「하나도 저장되지 않았다」가 참이다.
  if (purposeCount > 0) {
    try {
      await saveKindPurposes({
        clientId,
        changes: purposeChanges,
        updatedBy: admin.userId,
      });
    } catch (error) {
      console.error("[notifications] 알림 분류를 저장하지 못했습니다:", error);
      fail(`${system.name} — 분류를 저장하지 못했습니다. 아무것도 저장하지 않았습니다.`);
    }
  }

  // 🔴 보낼 것이 없으면 **아예 보내지 않는다.** 잠긴 네 시스템이 분류만 바꿔도
  // 403 을 보지 않는 까닭이 이 줄이다(머리말).
  if (changes.length === 0) done(`${system.name} — 분류 ${purposeCount}개를 저장했습니다.`);

  const result = await saveNotificationSettings({
    userId: admin.userId,
    clientId,
    changes,
  });

  // 🔴 실패를 성공으로 보여 주지 않는다. 저장됐다고 읽으면 사람이 화면을 닫고,
  // 그 알림은 아무도 모르는 채 옛 설정으로 계속 간다.
  //
  // 🔴 그러면서 이미 저장된 분류를 숨기지도 않는다 — 안 적으면 사람이 다시
  // 눌렀을 때 분류가 「바뀐 것이 없다」로 나오는 까닭을 알 수 없다.
  if (result.status !== "ok") {
    fail(
      purposeCount > 0
        ? `${system.name} — ${result.message} 분류 ${purposeCount}개는 저장했습니다.`
        : `${system.name} — ${result.message}`
    );
  }

  // 보낼 것은 있었는데 저쪽이 아무것도 안 바꿨다면, 그 사이 누군가 같은 값을
  // 이미 넣어 둔 것이다. 「저장했습니다」라고 적으면 숫자가 0인 까닭을 알 수 없다.
  if (result.changedCount === 0) {
    done(
      purposeCount > 0
        ? `${system.name} — 분류 ${purposeCount}개를 저장했습니다. 나머지는 이미 그 상태였습니다.`
        : `${system.name} — 이미 그 상태였습니다.`
    );
  }

  done(
    purposeCount > 0
      ? `${system.name} — ${result.changedCount}개 항목과 분류 ${purposeCount}개를 저장했습니다.`
      : `${system.name} — ${result.changedCount}개 항목을 저장했습니다.`
  );
}
