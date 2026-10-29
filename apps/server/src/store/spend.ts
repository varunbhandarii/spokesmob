import type { LedgerUsage, Repositories } from "./repositories.js";

export class SpendLedger {
  private sequence = 0;
  private entries = new Map<string, { reservation: number; usd: number | null }>();
  constructor(
    private readonly repository: Repositories["costLedger"],
    private sessionId: string,
    private cap: number,
  ) {
    this.setCap(cap);
  }
  setCap(cap: number) {
    if (!Number.isFinite(cap) || cap < 0) throw new RangeError("Spend cap must be nonnegative");
    this.cap = cap;
  }
  reset(sessionId: string) {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.sequence = 0;
    this.entries = new Map();
  }
  totals() {
    let spent = 0;
    let reserved = 0;
    let unknown = 0;
    for (const entry of this.entries.values()) {
      if (entry.usd === null) {
        reserved += entry.reservation;
        unknown++;
      } else spent += entry.usd;
    }
    return { spent, reserved, total: spent + reserved, unknown, cap: this.cap };
  }
  canReserve(amount: number): boolean {
    return (
      Number.isFinite(amount) &&
      amount >= 0 &&
      this.totals().total + amount <= this.cap + Number.EPSILON * Math.max(1, this.cap)
    );
  }
  reserve(
    source: "consensus" | "voice",
    now: number,
    beatId: string | null,
    amount = source === "consensus" ? 0.0005 : 0.0085,
  ): string | null {
    if (!this.canReserve(amount)) return null;
    const id = `${this.sessionId}:${++this.sequence}`;
    this.repository.add({
      id,
      sessionId: this.sessionId,
      at: now,
      source,
      beatId,
      usd: null,
      reservation: amount,
    });
    this.entries.set(id, { reservation: amount, usd: null });
    return id;
  }
  settle(id: string, usd: number | null, usage?: LedgerUsage | null) {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0))
      throw new RangeError("Usage cost must be nonnegative or unknown");
    const entry = this.entries.get(id);
    this.repository.update(id, usd, usage);
    if (entry && usd !== null) entry.usd = usd;
  }
}
