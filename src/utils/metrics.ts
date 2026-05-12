import { getCollection } from 'astro:content';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export async function aggregateMetrics() {
  const cases = await getCollection('case-studies', ({ data }) => !data.draft);

  let events: any[] = [];
  try {
    const eventsData = readFileSync('data/events.yaml', 'utf-8');
    events = (parse(eventsData) as any[]) ?? [];
  } catch {
    events = [];
  }

  return {
    hospitalCount: cases.length,
    totalSubsidy: cases.reduce((sum, c) => sum + (c.data.metrics.subsidyAmount ?? 0), 0),
    maxEnergySaving: Math.max(...cases.map(c => c.data.metrics.energySavingPercent ?? 0), 0),
    eventCount: events.length,
  };
}
