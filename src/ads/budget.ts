import { join } from 'node:path';
import { readJson, writeJson } from '../util/json-file.js';
import { AdsError } from './errors.js';

interface BudgetState {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Local daily counter of Google Ads API operations. Explorer access allows a
 * limited number of production operations per day; refusing locally avoids
 * burning the quota on calls that would fail anyway. Resets at 00:00 UTC
 * (Google's own reset time may differ slightly).
 */
export class OpsBudget {
  private readonly path: string;
  private state: BudgetState;

  constructor(
    dataDir: string,
    private readonly limit: number,
  ) {
    this.path = join(dataDir, 'ops-budget.json');
    this.state = readJson<BudgetState>(this.path, { date: today(), count: 0 });
  }

  consume(n = 1): void {
    this.rollover();
    if (this.state.count + n > this.limit) {
      throw new AdsError(
        'DAILY_BUDGET_EXHAUSTED',
        `Daily Google Ads operations budget reached (${this.limit}). It resets at 00:00 UTC.`,
      );
    }
    this.state.count += n;
    writeJson(this.path, this.state);
  }

  usage(): { date: string; used: number; limit: number } {
    this.rollover();
    return { date: this.state.date, used: this.state.count, limit: this.limit };
  }

  private rollover(): void {
    const d = today();
    if (this.state.date !== d) this.state = { date: d, count: 0 };
  }
}
