// The single entry point for outbound settlement: every successful outbound send (text or
// media) must close the contact's pending-reply ledger entry. Extracted so the send-text and
// send-media outbound paths share it, guaranteeing the invariant "any successful outbound to
// a contact settles its entry" cannot miss a path as new outbound types are added. (In the
// inbox architecture there is no channel history to write back — the agent's full context
// comes from the network-side archive via oan_gofer_history, and only the inbox tail exists
// locally.)
export interface OanOutboundSettlement {
  /** Close the contact's pending-reply ledger entry; may be omitted when no ledger is running */
  closeLedger?: (contactId: string) => void;
}

/**
 * Unified settlement after a successful outbound send. Must only be called after the send
 * truly succeeded — a failed send must let the exception propagate, leaving the entry on the
 * ledger for the next delivery.
 */
export function settleOutbound(
  contactId: string,
  _description: string | undefined,
  settlement: OanOutboundSettlement,
): void {
  settlement.closeLedger?.(contactId);
}

/**
 * Synthetic outbound message id: most OAN write endpoints return no message id to echo back
 * (chat/messages is 202 fire-and-forget; match-requests/decision carries none either), so a
 * locally unique id is generated to satisfy host interface requirements — never used as an
 * authoritative identifier on the OAN side.
 */
export function syntheticMessageId(): string {
  return `oan-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
