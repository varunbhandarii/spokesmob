import type {
  ActiveBeat,
  BeatLine,
  BeatLogRecord,
  BeatLogStatus,
  BeatState,
} from "../../../../packages/core/src/beat-types.js";
import { beatLogRecordSchema } from "../../../../packages/core/src/beat-types.js";
import type { SynthesisResult } from "../../../../packages/core/src/types.js";
import type { CollectorSnapshot } from "../consensus/collector.js";
import type { Repositories } from "../store/repositories.js";
import type { VoiceResult } from "../voice/types.js";

export interface BeatBook {
  id: number;
  closedAt: number;
  previewAt: number | null;
  playAt: number | null;
  startedAt: number | null;
  readyMs: number | null;
  result: SynthesisResult | null;
  line: BeatLine | null;
  voices: Partial<Record<"main" | "dissent", VoiceResult>>;
  snapshot: CollectorSnapshot | null;
  status: BeatLogStatus | null;
  gate: string | null;
  reason: string | null;
  at: number;
  mode: BeatState["mode"];
  windowVoices: number;
}
const wire = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      item === Number.NEGATIVE_INFINITY ? "-Infinity" : item,
    ),
  ) as T;
export class BeatRecords {
  readonly books = new Map<number, BeatBook>();
  constructor(
    private readonly store: Repositories,
    private readonly sessionId: string,
    private readonly emit: (row: BeatLogRecord) => void,
    private readonly safeNames: (names: readonly string[]) => string[],
  ) {}
  key(id: number): string {
    return `${this.sessionId}:${id}`;
  }
  begin(beat: ActiveBeat, mode: BeatState["mode"]): BeatBook {
    let book = this.books.get(beat.id);
    if (!book) {
      book = {
        id: beat.id,
        closedAt: beat.closedAt,
        previewAt: null,
        playAt: null,
        startedAt: null,
        readyMs: null,
        result: null,
        line: beat.line,
        voices: {},
        snapshot: null,
        status: null,
        gate: null,
        reason: null,
        at: beat.closedAt,
        mode,
        windowVoices: 0,
      };
      this.books.set(beat.id, book);
      while (this.books.size > 1000) this.books.delete(this.books.keys().next().value as number);
    }
    return book;
  }
  write(
    beat: ActiveBeat,
    state: BeatState,
    at: number,
    status: BeatLogStatus,
    gate: string | null,
    reason: string | null,
  ) {
    const book = this.begin(beat, state.mode);
    book.line = beat.line;
    book.status = status;
    book.gate = gate ?? book.gate;
    book.reason = reason ?? book.reason;
    book.at = at;
    const row = this.row(book, beat.kind, book.mode);
    if (this.store.beatLog.get(row.id)) this.store.beatLog.update(row.id, row);
    else this.store.beatLog.insert(row);
    book.snapshot = null;
    this.emit(row);
  }
  update(id: number) {
    const book = this.books.get(id);
    const previous = this.store.beatLog.get(this.key(id));
    if (!book?.status || !previous) return;
    const row = this.row(book, previous.kind, previous.mode);
    this.store.beatLog.update(row.id, row);
    this.emit(row);
  }
  private row(book: BeatBook, kind: "consensus" | "event", mode: BeatState["mode"]): BeatLogRecord {
    const line = book.line;
    const costs = this.store.costLedger.beatTotal(this.key(book.id));
    const attempts = Object.values(book.voices).flatMap((result) =>
      result.attempts.map(({ transcript: _transcript, ...attempt }, index) => ({
        ...attempt,
        channel: result.channel,
        take: result.take,
        attempt: index + 1,
      })),
    );
    return beatLogRecordSchema.parse(
      wire({
        id: this.key(book.id),
        at: book.at,
        kind,
        mode,
        status: book.status ?? "skipped",
        gate: book.gate,
        reason: book.reason,
        line: line?.text ?? null,
        dissent: line?.dissent ?? null,
        pct: line?.pct ?? book.result?.pct ?? 0,
        voices: line?.voices ?? book.result?.voices ?? book.windowVoices,
        mood: line?.mood ?? book.result?.mood ?? null,
        citedExemplars: line?.citedExemplars ?? [],
        citedNames: this.safeNames(line?.citedNames ?? []),
        latency: {
          assemblyMs: book.result?.latency.assembly ?? null,
          clusteringMs: book.result?.latency.clustering ?? null,
          moderationMs: book.result?.latency.inputModeration ?? null,
          modelMs: book.result?.latency.model ?? null,
          verifierMs: book.result?.latency.verification ?? null,
          holdMs:
            book.playAt !== null && book.previewAt !== null ? book.playAt - book.previewAt : null,
          voiceReadyMs: book.readyMs,
          preRollMs:
            book.startedAt !== null && book.playAt !== null ? book.startedAt - book.playAt : null,
        },
        e2eMs: book.startedAt === null ? null : book.startedAt - book.closedAt,
        voiceAttempts: attempts,
        costUsd: costs.usd,
        unknownCost: costs.unknownCount > 0,
      }),
    );
  }
}
