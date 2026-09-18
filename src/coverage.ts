export const INTERNAL_REASON = "internal: item never resolved";

export type Slot =
  | { state: "pending" }
  | { state: "answered"; answers: Record<string, unknown> }
  | { state: "failed"; reason: string };

export type FinishReport = {
  total: number;
  answered: number;
  failed: number;
  unresolved: number[];
};

export class Coverage {
  readonly total: number;
  private readonly slots: Slot[];

  constructor(total: number) {
    this.total = total;
    this.slots = Array.from({ length: total }, () => ({ state: "pending" }) as Slot);
  }

  private slot(index: number): Slot {
    const slot = this.slots[index];
    if (!slot) throw new Error(`coverage: index ${index} is outside 0..${this.total - 1}`);
    return slot;
  }

  private settle(index: number, next: Slot): void {
    const slot = this.slot(index);
    if (slot.state !== "pending") {
      throw new Error(`coverage: index ${index} was already settled as ${slot.state}`);
    }
    this.slots[index] = next;
  }

  answer(index: number, answers: Record<string, unknown>): void {
    this.settle(index, { state: "answered", answers });
  }

  fail(index: number, reason: string): void {
    this.settle(index, { state: "failed", reason });
  }

  get(index: number): Slot {
    return this.slot(index);
  }

  isSettled(index: number): boolean {
    return this.slot(index).state !== "pending";
  }

  /**
   * Converts every still-pending slot into a named failure so that no item can leave the
   * run unaccounted for, and reports which ones they were. With no reason given, a pending
   * slot means the pool lost an item — a bug, reported separately from an item that
   * genuinely failed. A run that aborted passes its own reason instead.
   */
  finish(pendingReason: string = INTERNAL_REASON): FinishReport {
    const unresolved: number[] = [];
    let answered = 0;
    let failed = 0;
    for (let i = 0; i < this.total; i++) {
      const slot = this.slot(i);
      if (slot.state === "pending") {
        unresolved.push(i);
        this.slots[i] = { state: "failed", reason: pendingReason };
        failed++;
      } else if (slot.state === "answered") {
        answered++;
      } else {
        failed++;
      }
    }
    return { total: this.total, answered, failed, unresolved };
  }
}
