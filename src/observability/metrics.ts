import { LiteError } from "../contracts/errors.js";

export interface LiteHistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly average: number | null;
}

export interface LiteMetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, LiteHistogramSnapshot>>;
}

interface MutableHistogram {
  count: number;
  sum: number;
  minimum: number | null;
  maximum: number | null;
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be finite`);
  }
}

export class LiteMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, MutableHistogram>();

  increment(name: string, amount = 1): void {
    assertFinite(amount, "amount");
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  setGauge(name: string, value: number): void {
    assertFinite(value, "value");
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    assertFinite(value, "value");
    const histogram = this.histograms.get(name) ?? {
      count: 0,
      sum: 0,
      minimum: null,
      maximum: null,
    };
    histogram.count += 1;
    histogram.sum += value;
    histogram.minimum = histogram.minimum === null ? value : Math.min(histogram.minimum, value);
    histogram.maximum = histogram.maximum === null ? value : Math.max(histogram.maximum, value);
    this.histograms.set(name, histogram);
  }

  snapshot(): LiteMetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const key of [...this.counters.keys()].sort()) {
      counters[key] = this.counters.get(key) ?? 0;
    }
    const gauges: Record<string, number> = {};
    for (const key of [...this.gauges.keys()].sort()) {
      gauges[key] = this.gauges.get(key) ?? 0;
    }
    const histograms: Record<string, LiteHistogramSnapshot> = {};
    for (const key of [...this.histograms.keys()].sort()) {
      const histogram = this.histograms.get(key);
      if (histogram === undefined) continue;
      histograms[key] = {
        count: histogram.count,
        sum: histogram.sum,
        minimum: histogram.minimum,
        maximum: histogram.maximum,
        average: histogram.count === 0 ? null : histogram.sum / histogram.count,
      };
    }
    return { counters, gauges, histograms };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}
