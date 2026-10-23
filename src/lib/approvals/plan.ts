import type { GatheredApprovalItem } from "./gather";
import { findApprovalMailKind, isApprovalMailKindEnabled } from "./kinds";

/**
 * ============================================================================
 * 모아 온 결재건 가운데 **메일로 알릴 것**을 고른다 — 순수 계산만
 * ============================================================================
 * 네 가지를 뺀다. 🔴 **몇 개를 왜 뺐는지 전부 센다.** 조용히 빠지면 증상이
 * 「메일이 안 온다」 하나뿐이라 어디를 봐야 할지 알 수 없다 — 꺼 둔 것인지,
 * 이미 보낸 것인지, 포털이 모르는 갈래인지가 완전히 다른 일이다.
 *
 *  ① **모르는 갈래** — approvals/kinds.ts 의 다섯에 없는 `kind`. 어느 시스템이
 *     갈래를 늘렸는데 포털이 아직 모르는 상태다. 🔴 메일은 안 나가되 **그 수가
 *     기록에 남는다**(0 이 아니면 포털에 한 줄 더할 때가 된 것이다).
 *  ② **꺼 둔 갈래** — 관리자가 끈 것. 기본값이 「전부 끔」이므로 아무도 켜지
 *     않았으면 모두 여기로 빠진다.
 *  ③ **이미 보낸 건** — 보낸 기록이 있는 (사람, 시스템, 결재건). 이 작업은
 *     날마다 돌고 결재는 며칠씩 남아 있으므로, 이것이 없으면 같은 메일이 날마다
 *     간다.
 *  ④ **이번 답 안에서 겹친 줄** — 같은 열쇠가 두 번 왔을 때. 저쪽이 겹쳐 보내는
 *     일은 없어야 하지만, 겹친 채로 그냥 두면 **보낸 기록을 적는 한 문장이 통째로
 *     실패한다**(한 INSERT 안에서 같은 열쇠를 두 번 고칠 수 없다는 Postgres 의
 *     규칙). 메일은 이미 나간 뒤라 기록만 사라지고, 그러면 내일 또 보낸다.
 *
 * 🔵 네 수를 세기만 하고 던지지 않는다. 고를 것이 하나도 없으면 빈 목록이고,
 * **메일은 아예 나가지 않는다**(approvals/run.ts).
 * ============================================================================
 */

/**
 * 보낸 기록 하나를 가리키는 열쇠. `{client_id}:{item_id}`.
 *
 * 🔴 DB 의 열쇠는 **세 칸**(user_id · client_id · item_id)이다. 이 글자는 한
 * 사람 몫을 메모리에서 맞춰 보기 위한 것이라 사람이 빠져 있다 — 사람이 섞이는
 * 일이 없도록, 이 열쇠로 만든 집합은 **그 사람 것만** 담아 넘긴다
 * (queries/approval-mail-deliveries.ts 가 `user_id` 로 걸러 읽는다).
 *
 * 🔵 붙이기만 하고 가르지 않는다(approvals/kinds.ts 의 `approvalKindKey` 와 같은
 * 판단). 결재건 id 에는 `:` 가 들어 있다(`REPAIR_CASE_APPROVAL:…:FINAL_SHIPMENT`).
 */
export function approvalDeliveryKey(clientId: string, itemId: string): string {
  return `${clientId}:${itemId}`;
}

export type ApprovalMailSelection = {
  /** 메일로 알릴 것. 🔴 받은 차례 그대로다(시스템 차례 → 저쪽이 세운 차례). */
  toSend: GatheredApprovalItem[];
  skippedUnknownKind: number;
  skippedDisabled: number;
  skippedAlreadySent: number;
  skippedDuplicate: number;
};

export function selectApprovalsToMail(params: {
  items: readonly GatheredApprovalItem[];
  /** 켜 둔 갈래의 열쇠(`{client_id}:{kind}`). 없는 것은 꺼짐이다. */
  enabledKeys: ReadonlySet<string>;
  /** 이 사람에게 이미 보낸 것들(`{client_id}:{item_id}`). */
  alreadySent: ReadonlySet<string>;
}): ApprovalMailSelection {
  const toSend: GatheredApprovalItem[] = [];
  const seen = new Set<string>();

  let skippedUnknownKind = 0;
  let skippedDisabled = 0;
  let skippedAlreadySent = 0;
  let skippedDuplicate = 0;

  for (const item of params.items) {
    if (!findApprovalMailKind(item.clientId, item.kind)) {
      skippedUnknownKind += 1;
      continue;
    }
    if (!isApprovalMailKindEnabled(params.enabledKeys, item.clientId, item.kind)) {
      skippedDisabled += 1;
      continue;
    }

    const key = approvalDeliveryKey(item.clientId, item.id);
    if (params.alreadySent.has(key)) {
      skippedAlreadySent += 1;
      continue;
    }
    if (seen.has(key)) {
      skippedDuplicate += 1;
      continue;
    }

    seen.add(key);
    toSend.push(item);
  }

  return { toSend, skippedUnknownKind, skippedDisabled, skippedAlreadySent, skippedDuplicate };
}
