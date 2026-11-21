/**
 * A log panel's rows, by page (REQ-000029-sJpO9KMY Requirement 2,
 * br-LOGV-000001-sJpO9KMY): cttc's 200-row pages, fetched only when in view
 * and kept once loaded. Unlike cttc (bug 21, where a rejected page's promise
 * stayed in the cache and the rows never came), a failed page is not kept: it
 * reads as loading, is fetched again after 1, 2, 4 ... up to 30 s while in
 * view, and at once when it comes back into view.
 *
 * The rows are those of one source over one time range in one order; a new
 * read (`reset`) keeps the old rows on show until their page comes again, so
 * the panel does not blink every 5 s.
 */

/** Rows a page holds: cttc's `PAGE`. */
export const PAGE = 200;
/** The first retry's delay; it doubles up to `RETRY_MAX_MS`. */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/** One log row, as the Sump gives it. */
export interface LogRow {
  ts: string;
  text: string;
  [field: string]: unknown;
}

/** One page's answer. */
export interface PageReply {
  rows: LogRow[];
  total: number;
}

/** Fetch page `page` (rows `page*PAGE` onwards); rejects when it cannot. */
export type FetchPage = (page: number) => Promise<PageReply>;

/** The cache's clock and its log, replaceable in tests. */
export interface PageCacheOptions {
  /** Called whenever rows or the total change. */
  onChange?: () => void;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  log?: (message: string) => void;
}

/** The delay before retry number `attempt` (1, 2, ...): 1 s, 2 s, 4 s ... 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1));
}

/** The pages a row range touches. */
export function pagesOf(i0: number, i1: number): number[] {
  if (i1 < i0) return [];
  const pages: number[] = [];
  for (let p = Math.floor(i0 / PAGE); p <= Math.floor(i1 / PAGE); p++) pages.push(p);
  return pages;
}

/** A panel's pages. */
export class PageCache {
  /** The rows' total, from the last page that came; null before any. */
  total: number | null = null;
  private pages = new Map<number, LogRow[]>();
  private stale = new Map<number, LogRow[]>();
  private loading = new Set<number>();
  private failed = new Map<number, { attempt: number; timer: unknown }>();
  private inView = new Set<number>();
  private generation = 0;
  private readonly schedule: (run: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly log: (message: string) => void;

  constructor(
    private fetchPage: FetchPage,
    private readonly options: PageCacheOptions = {},
  ) {
    this.schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as number));
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Row `index`, from its page or the last read's; undefined while loading. */
  row(index: number): LogRow | undefined {
    const p = Math.floor(index / PAGE);
    return (this.pages.get(p) ?? this.stale.get(p))?.[index % PAGE];
  }

  /** Whether page `page` is loaded in this read. */
  has(page: number): boolean {
    return this.pages.has(page);
  }

  /** Rows `i0`..`i1` are in view: fetch the pages they need. */
  want(i0: number, i1: number): void {
    const wanted = new Set(pagesOf(i0, i1));
    for (const p of wanted) {
      if (this.pages.has(p) || this.loading.has(p)) continue;
      const failure = this.failed.get(p);
      // A failed page waits for its retry while it stays in view; one that
      // comes back into view is fetched at once.
      if (failure && this.inView.has(p)) continue;
      if (failure) this.cancel(failure.timer);
      void this.load(p);
    }
    this.inView = wanted;
  }

  /** A new read (another view or order, or 5 s on): every page is fetched again. */
  reset(fetchPage?: FetchPage): void {
    if (fetchPage) this.fetchPage = fetchPage;
    this.generation++;
    for (const [p, rows] of this.pages) this.stale.set(p, rows);
    this.pages = new Map();
    this.loading.clear();
    for (const { timer } of this.failed.values()) this.cancel(timer);
    this.failed.clear();
    this.inView = new Set();
  }

  /** Forget everything, old rows too (another source or order). */
  clear(fetchPage?: FetchPage): void {
    this.reset(fetchPage);
    this.stale.clear();
    this.total = null;
  }

  /** Stop the retries. */
  dispose(): void {
    this.reset();
  }

  /** Load page `p`: kept when it comes; on failure kept out and retried. */
  private async load(p: number): Promise<void> {
    const generation = this.generation;
    this.loading.add(p);
    const attempt = (this.failed.get(p)?.attempt ?? 0) + 1;
    try {
      const reply = await this.fetchPage(p);
      if (generation !== this.generation) return;
      this.loading.delete(p);
      this.failed.delete(p);
      this.pages.set(p, reply.rows);
      this.stale.delete(p);
      this.total = reply.total;
      this.options.onChange?.();
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading.delete(p);
      const delay = retryDelay(attempt);
      this.log(
        `log page ${p} failed (attempt ${attempt}): ${(error as Error)?.message ?? error}; again in ${delay / 1000} s`,
      );
      const timer = this.schedule(() => {
        if (generation !== this.generation || !this.failed.has(p)) return;
        // Out of view, it waits to come back into view.
        if (this.inView.has(p)) void this.load(p);
        else this.failed.delete(p);
      }, delay);
      this.failed.set(p, { attempt, timer });
      this.options.onChange?.();
    }
  }
}
