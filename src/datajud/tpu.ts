/**
 * Plain-English hints for common movement codes from CNJ's Unified Procedural Tables (TPU).
 *
 * DataJud returns only the *leaf* name of a TPU movement, which is often meaningless out of
 * context ("Provisório", "Confirmada", "de Instrução e Julgamento"). These hints give the model
 * that context. The table is intentionally small: it covers codes observed in recorded responses,
 * and anything else falls back to the raw Portuguese name. Hints are advisory, not legal advice.
 */

export const MOVEMENT_KINDS = [
  "decision",
  "hearing",
  "notice",
  "deadline",
  "suspension",
  "archival",
  "closure",
  "filing",
  "routine",
  "administrative",
] as const;

export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export interface MovementHint {
  kind: MovementKind;
  label: string;
}

const h = (kind: MovementKind, label: string): MovementHint => ({ kind, label });

export const TPU_HINTS: ReadonlyMap<number, MovementHint> = new Map([
  // Decisions and judgments
  [219, h("decision", "Judgment on the merits: claim granted (in criminal cases, a conviction)")],
  [220, h("decision", "Judgment on the merits: claim denied")],
  [239, h("decision", "Appeal dismissed on the merits")],
  [200, h("decision", "Motion for clarification (embargos de declaração) rejected")],
  [12455, h("decision", "Request denied")],
  [12164, h("decision", "Court decision (other)")],
  [196, h("decision", "Enforcement of judgment declared extinguished")],
  [458, h("decision", "Case dismissed for abandonment by the plaintiff")],
  // Hearings
  [970, h("hearing", "Hearing")],
  [12750, h("hearing", "Evidentiary and judgment hearing (instrução e julgamento)")],
  [897, h("hearing", "Removed from the session calendar")],
  // Notices and publications (often start procedural deadlines)
  [12265, h("notice", "Summons or notice issued to a party")],
  [12282, h("notice", "Summons or notice issued to a party")],
  [12266, h("notice", "Delivery of a notice confirmed")],
  [92, h("notice", "Published in the official gazette")],
  [1061, h("notice", "Made available in the electronic official gazette (DJe)")],
  [106, h("notice", "Court writ (mandado) executed")],
  [985, h("notice", "Court writ (mandado) issued")],
  // Deadlines
  [1051, h("deadline", "A procedural deadline expired")],
  // Suspension
  [898, h("suspension", "Case suspended by court order")],
  [12066, h("suspension", "Suspension lifted")],
  // Archival and closure
  [245, h("archival", "Records archived provisionally (may be reopened)")],
  [246, h("archival", "Records archived permanently")],
  [848, h("closure", "Judgment became final (trânsito em julgado)")],
  [22, h("closure", "Case formally closed (baixa definitiva)")],
  // Filings
  [26, h("filing", "Case filed and assigned to a court unit")],
  [85, h("filing", "Petition filed by a party")],
  [118, h("filing", "Petition filed (protocol)")],
  // Routine court work
  [51, h("routine", "Records sent to the judge for a decision or order")],
  [11010, h("routine", "Routine procedural order")],
  [11383, h("routine", "Clerk's procedural act")],
  [581, h("routine", "Document added to the records")],
  [60, h("routine", "Document issued by the court")],
  [132, h("routine", "Records received")],
  [123, h("routine", "Records sent to another unit or court")],
  [982, h("routine", "Records sent to another unit or court")],
  [12215, h("routine", "Records returned to the clerk's office")],
  [36, h("administrative", "Case reassigned to another court unit")],
  // Data maintenance
  [10966, h("administrative", "Procedural class changed")],
  [14738, h("administrative", "Procedural class corrected")],
  [14739, h("administrative", "Procedural class evolved (e.g. into enforcement of judgment)")],
  [12142, h("administrative", "Party data changed")],
  [12143, h("administrative", "Case subject changed")],
]);

export function movementHint(code: number | null): MovementHint | null {
  return code === null ? null : (TPU_HINTS.get(code) ?? null);
}
