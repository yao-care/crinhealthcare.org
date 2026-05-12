/**
 * seed-events.ts
 * Extract activity events from source materials and write to data/events.yaml.
 *
 * Sources:
 *   - 國際醫療減碳協會2025年度會刊(最終版).md  (10-event table + certification schedule)
 *   - 協會活動統整.md  (carbon audit kickoff meetings)
 *
 * ROC → ISO date conversion:
 *   - 7-digit RRRYMMDD (e.g. 1131104) → YYYY-MM-DD
 *   - RRR/MM/DD (e.g. 113/11/04)     → YYYY-MM-DD
 *   - YYYY/MM/DD (e.g. 2024/8/9)     → YYYY-MM-DD
 *   ROC year + 1911 = Western year
 */

import { readSourceFile, writeDataFile } from './lib/fs-utils.js';

interface Event {
  date: string;
  title: string;
  organization: string;
  attendees: number | null;
  type: 'seminar' | 'certification' | 'meeting' | 'donation' | 'exhibition';
}

// ---------------------------------------------------------------------------
// Date conversion helpers
// ---------------------------------------------------------------------------

/** Convert various Taiwan date formats to ISO YYYY-MM-DD */
function toISO(raw: string): string {
  raw = raw.trim();

  // YYYY/M/D or YYYY-M-D (already western year)
  const westernSlash = raw.match(/^(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (westernSlash) {
    const [, y, m, d] = westernSlash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // 7-digit ROC compact: RRRYMMDD (e.g. 1131104 = ROC 113, month 11, day 04)
  const compact7 = raw.match(/^(1\d{2})(\d{2})(\d{2})$/);
  if (compact7) {
    const [, roc, m, d] = compact7;
    return `${parseInt(roc) + 1911}-${m}-${d}`;
  }

  // ROC slash format: RRR/MM/DD or RRR/M/D (e.g. 113/11/04 or 114/3/27)
  const rocSlash = raw.match(/^(1\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (rocSlash) {
    const [, roc, m, d] = rocSlash;
    return `${parseInt(roc) + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  throw new Error(`Cannot parse date: "${raw}"`);
}

// ---------------------------------------------------------------------------
// Event type classifier
// ---------------------------------------------------------------------------
function classifyType(title: string): Event['type'] {
  if (/捐贈/.test(title)) return 'donation';
  if (/國際醫療展|展覽|展示/.test(title)) return 'exhibition';
  if (/授證/.test(title)) return 'certification';
  if (/研討|課程|講習|培訓/.test(title)) return 'seminar';
  return 'meeting';
}

// ---------------------------------------------------------------------------
// Parse the 10-event table from the annual report
// Markdown table rows look like:
// | 1 | 2024/08/09 | 創新智能醫療應用研討會 | 國防醫學院 | 36 |
// ---------------------------------------------------------------------------
function parseAnnualReportEvents(src: string): Event[] {
  const events: Event[] = [];

  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const cols = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    // We want rows where col[0] is a 1-2 digit number (serial 1–10)
    if (!/^\d{1,2}$/.test(cols[0])) continue;

    // cols: [no, date, title, org, attendees]
    if (cols.length < 5) continue;

    const [, dateRaw, title, organization, attendeesRaw] = cols;

    let date: string;
    try {
      date = toISO(dateRaw);
    } catch {
      console.warn(`Skipping row with unparseable date: ${dateRaw}`);
      continue;
    }

    const attendees = parseInt(attendeesRaw, 10);

    events.push({
      date,
      title,
      organization,
      attendees: isNaN(attendees) ? null : attendees,
      type: classifyType(title),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Parse kickoff meetings from 協會活動統整.md
// These are carbon-audit kickoff meetings (碳盤查啟動會議) from the
// per-hospital sections at the top of the file.
// Format: "第一次113年度溫室氣體碳盤查啟動會議：1131104，..."
// ---------------------------------------------------------------------------
function parseActivityEvents(src: string): Event[] {
  const events: Event[] = [];
  let currentOrg = '';

  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip HTML comments
    if (trimmed.startsWith('<!--')) continue;

    // Detect organization header lines (short, no colon, not a bullet/date line)
    // These are standalone lines like "台中國軍總醫院" or "國防醫學大學"
    if (
      trimmed.length >= 4 &&
      trimmed.length <= 20 &&
      !trimmed.includes('：') &&
      !trimmed.includes(':') &&
      !trimmed.includes('，') &&
      !/^\d/.test(trimmed) &&
      !/^第/.test(trimmed) &&
      !/^第三方/.test(trimmed) &&
      !/^ISO/.test(trimmed) &&
      !/^預計/.test(trimmed) &&
      !/^建議/.test(trimmed)
    ) {
      currentOrg = trimmed;
      continue;
    }

    // Match kickoff meeting lines
    // e.g. "第一次113年度溫室氣體碳盤查啟動會議：1131104，預劃1140430完成"
    // e.g. "第一次114年度溫室氣體碳盤查啟動會議:115/03/26"
    const kickoffMatch = trimmed.match(
      /第[一二三四五六七八九十]+次(\d{3})年度溫室氣體碳盤查啟動會議[：:]\s*([0-9\/]+)/,
    );
    if (kickoffMatch && currentOrg) {
      const [, , dateRaw] = kickoffMatch;
      let date: string;
      try {
        date = toISO(dateRaw);
      } catch {
        console.warn(`Skipping kickoff date: ${dateRaw} (${currentOrg})`);
        continue;
      }

      events.push({
        date,
        title: '溫室氣體碳盤查啟動會議',
        organization: currentOrg,
        attendees: null,
        type: 'meeting',
      });
      continue;
    }

    // Match third-party certification completion lines
    // e.g. "第三方認證1140905完成"  or "第三方認證1150203完成"
    const certMatch = trimmed.match(/^第三方認證(\d{7})完成$/);
    if (certMatch && currentOrg) {
      const dateRaw = certMatch[1];
      let date: string;
      try {
        date = toISO(dateRaw);
      } catch {
        console.warn(`Skipping cert date: ${dateRaw} (${currentOrg})`);
        continue;
      }

      events.push({
        date,
        title: '第三方認證完成',
        organization: currentOrg,
        attendees: null,
        type: 'certification',
      });
      continue;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// De-duplicate events: same date + organization + type → keep first occurrence
// ---------------------------------------------------------------------------
function dedup(events: Event[]): Event[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = `${e.date}|${e.organization}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const annualSrc = readSourceFile('國際醫療減碳協會2025年度會刊(最終版).md');
const activitySrc = readSourceFile('協會活動統整.md');

// The 10 major events from the annual report table (with attendee counts) are authoritative
const annualEvents = parseAnnualReportEvents(annualSrc);

// Kickoff meetings and certification events from the activity log
const activityEvents = parseActivityEvents(activitySrc);

// Merge: annual report events first (they have attendee counts), then activity extras
const allEvents = dedup([...annualEvents, ...activityEvents]);

// Sort by date ascending
allEvents.sort((a, b) => a.date.localeCompare(b.date));

writeDataFile('events.yaml', allEvents);
console.log(`Done. ${allEvents.length} events written to data/events.yaml`);
console.log(`  - ${annualEvents.length} from annual report event table`);
console.log(`  - ${activityEvents.length} from activity log (before dedup)`);
