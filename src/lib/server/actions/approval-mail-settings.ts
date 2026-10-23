"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { diffSubmittedApprovalKinds, findApprovalMailKind } from "@/lib/approvals/kinds";
import { readApprovalInboxUrl } from "@/lib/approvals/inbox-url";
import { buildApprovalTestMailMessage } from "@/lib/approvals/mail-message";
import { assertPortalAdmin } from "@/lib/auth/portal-admin";
import { saveApprovalMailKinds } from "@/lib/db/mutations/approval-mail-kinds";
import { listEnabledApprovalMailKinds } from "@/lib/db/queries/approval-mail-kinds";
import { sendPlainMail } from "@/lib/mail/send";

/**
 * ============================================================================
 * 결재 알림 메일 — 갈래 켜고 끄기, 그리고 시험 메일 한 통
 * ============================================================================
 * 🔴 **이 값은 포털이 가진다.** 종 설정(사용 · 역할)이 각 시스템의 것인 것과
 * 다르다 — 메일을 보내는 쪽이 포털이기 때문이다. 세 시스템은 「이 사람이 결재할
 * 건」을 내줄 뿐이고, 그중 무엇을 메일로 알릴지는 포털의 결정이다.
 *
 * 🔴 **기본값은 전부 끔**(2026-10-23 결정). 그래서 이 화면에서 켜기 전까지는
 * 메일이 한 통도 나가지 않는다 — 켜는 것이 사람이 하는 일이다.
 *
 * ── 권한 ──────────────────────────────────────────────────────────────────
 * 포털 관리자만. 액션은 화면을 거치지 않고 직접 불릴 수 있으므로 스스로 본다
 * (portal-admin.ts 가 화면 가드와 액션 가드를 따로 두는 그 까닭).
 * 🔵 「그 시스템의 관리자인가」는 보지 않는다. 이 스위치는 **포털이 보내는 메일**
 * 에 대한 것이지 그 시스템의 설정이 아니다.
 * ============================================================================
 */

const PATH = "/admin/notifications";
/** 저장하고 돌아오면 그 구역이 바로 보이게. 화면의 `id` 와 같은 글자다. */
const ANCHOR = "approval-mail";

function resultUrl(kind: "ok" | "error", message: string): string {
  return `${PATH}?${kind}=${encodeURIComponent(message)}#${ANCHOR}`;
}

/** 🔴 redirect 는 던진다 — 부르는 쪽에서 try 로 감싸면 안 된다. */
function fail(reason: string): never {
  redirect(resultUrl("error", reason));
}

function done(notice: string): never {
  revalidatePath(PATH);
  redirect(resultUrl("ok", notice));
}

/**
 * 다섯 스위치를 저장한다.
 *
 * ── 왜 저장 직전에 한 번 더 읽는가 ────────────────────────────────────────
 * 폼은 「사람이 원하는 상태」만 실어 온다. 무엇이 **바뀌었는지**를 알려면 지금
 * 값이 있어야 하고, 화면을 그릴 때의 값을 숨은 칸으로 되받으면 화면을 열어 둔
 * 사이 다른 관리자가 바꾼 것까지 되돌려 놓게 된다(notification-settings.ts 의
 * 같은 자리와 같은 판단). 다섯 줄짜리 표라 읽는 값이 사실상 없다.
 *
 * 🔴 **켠 것을 특히 또렷이 알린다.** 켜는 순간부터 사람들의 메일함으로 진짜
 * 메일이 나가기 시작한다 — 「저장했습니다」만 적으면 무엇이 시작됐는지 알 수 없다.
 */
export async function saveApprovalMailKindSettings(formData: FormData) {
  const admin = await assertPortalAdmin();

  let enabledKeys: ReadonlySet<string>;
  try {
    enabledKeys = await listEnabledApprovalMailKinds();
  } catch (error) {
    console.error("[approvals-mail] 지금 켜진 갈래를 읽지 못했습니다:", error);
    fail(
      "지금 설정을 읽지 못해 저장하지 않았습니다. 마이그레이션(approval_mail_kinds)이 적용됐는지 확인해 주세요."
    );
  }

  const changes = diffSubmittedApprovalKinds({ form: formData, enabledKeys });
  if (changes.length === 0) done("결재 알림 메일 — 바뀐 것이 없습니다.");

  try {
    await saveApprovalMailKinds({ changes, updatedBy: admin.userId });
  } catch (error) {
    console.error("[approvals-mail] 갈래 설정을 저장하지 못했습니다:", error);
    fail("결재 알림 메일 설정을 저장하지 못했습니다. 아무것도 저장되지 않았습니다.");
  }

  const turnedOn = changes.filter((change) => change.enabled);
  const turnedOff = changes.filter((change) => !change.enabled);
  const names = (rows: typeof changes) =>
    rows
      .map((row) => findApprovalMailKind(row.clientId, row.kind)?.label ?? row.kind)
      .join(" · ");

  done(
    [
      turnedOn.length > 0 ? `메일을 보냅니다: ${names(turnedOn)}` : "",
      turnedOff.length > 0 ? `끔: ${names(turnedOff)}` : "",
    ]
      .filter((part) => part !== "")
      .join(" / ")
  );
}

/**
 * 「시험 메일 보내기」 — 🔴 **누른 사람 자신에게만 한 통.**
 *
 * 이 단추가 있는 까닭: 메일 설정이 틀리면 **결재 알림이 조용히 안 나가고** 아무도
 * 모른다. 결재는 처리될 때까지 남아 있으니 언젠가 사람이 알아차리겠지만, 그
 * 「언젠가」가 며칠이다. 그래서 켜기 전에 한 통을 실제로 보내 본다(A/S 의 메일
 * 설정 화면에 같은 단추가 있고, 까닭도 같다).
 *
 * 🔴 받는 사람은 **세션에서 구한다** — 화면이 주소를 정할 수 없다. 화면이 주소를
 * 보낼 수 있으면 이 단추가 「아무에게나 메일을 보내는 통로」가 된다.
 *
 * 🔴 **가짜 건수로 보낸다.** 실제 결재를 끌어오지 않는다 — 시험 메일에 진짜
 * 건수가 실릴 까닭이 없다(approvals/mail-message.ts 의 그 주석).
 */
export async function sendApprovalTestMail() {
  const admin = await assertPortalAdmin();

  if (!admin.email) {
    fail("내 계정에 메일 주소가 없어 보낼 곳이 없습니다. 포털 계정의 메일 주소를 채워 주세요.");
  }

  const message = buildApprovalTestMailMessage(readApprovalInboxUrl());
  const result = await sendPlainMail({
    to: admin.email,
    subject: message.subject,
    text: message.text,
  });

  if (!result.ok) {
    // 🔴 실패를 성공으로 보여 주지 않는다. 「보냈습니다」로 읽으면 설정이 틀린
    //    채로 켜게 되고, 그때부터 결재 알림이 조용히 안 나간다.
    fail(
      result.reason === "NOT_CONFIGURED"
        ? `메일 서버 설정이 아직 없습니다. ${result.message}`
        : `보내지 못했습니다: ${result.message}`
    );
  }

  done(`${admin.email} 으로 시험 메일을 보냈습니다. 받은 편지함을 확인해 주세요.`);
}
