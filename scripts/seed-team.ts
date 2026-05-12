/**
 * seed-team.ts
 * Extract team members from source materials and write to data/team.yaml.
 *
 * Sources:
 *   - 葉蔭民 理事長.md  (chairman bio)
 *   - 國際醫療減碳協會2025年度會刊(最終版).md  (org table)
 */

import { readSourceFile, writeDataFile } from './lib/fs-utils.js';

interface TeamMember {
  name: string;
  title: string;
  role: string;
  bio: string;
}

// ---------------------------------------------------------------------------
// Parse chairman bio from 葉蔭民 理事長.md
// ---------------------------------------------------------------------------
function parseChairmanBio(src: string): string {
  // Extract the 現職 paragraph — first non-empty paragraph after 一、現職
  const lines = src.split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '一、現職') {
      inSection = true;
      continue;
    }
    if (inSection && trimmed.startsWith('葉蔭民 理事長')) {
      // skip the name line itself
      continue;
    }
    if (inSection && trimmed.length > 20) {
      // First substantial paragraph is the bio
      return trimmed;
    }
    // Stop at next section
    if (inSection && /^[二三四五六七八九十]、/.test(trimmed)) break;
  }
  return '現任國際醫療減碳協會理事長，長期致力於推動醫療機構永續治理、溫室氣體盤查與ESG制度建置。';
}

// ---------------------------------------------------------------------------
// Build team member list from the org table in the annual report
// ---------------------------------------------------------------------------
function buildTeam(chairmanBio: string): TeamMember[] {
  return [
    {
      name: '葉蔭民',
      title: '理事長',
      role: 'chairman',
      bio: chairmanBio,
    },
    {
      name: '吳宜昌',
      title: '榮譽理事長',
      role: 'honorary-chairman',
      bio: '前軍醫局局長，提供協會專業指導與外部資源連結。',
    },
    {
      name: '（待補）',
      title: '榮譽理事長',
      role: 'honorary-chairman',
      bio: '提供協會專業指導與外部資源連結。',
    },
    {
      name: '（待補）',
      title: '總幹事',
      role: 'secretary-general',
      bio: '負責協會日常行政管理與跨部門協調。',
    },
    {
      name: '（待補）',
      title: '企劃室主任',
      role: 'planning-director',
      bio: '負責專案規劃、進度追蹤與成果彙報。',
    },
    {
      name: '（待補）',
      title: '會務行政組',
      role: 'admin-team',
      bio: '處理日常會務、財務、會員資料管理等行政工作（共2人）。',
    },
    {
      name: '（待補）',
      title: '綜合能源應用組 召集人',
      role: 'energy-convener',
      bio: '負責 ISO 50001 能源管理系統、節能技術與再生能源應用輔導。',
    },
    {
      name: '（待補）',
      title: 'AI 應用技術組 召集人',
      role: 'ai-tech-convener',
      bio: '負責導入醫療 AI 治理、智慧化減碳方案與算力支援。',
    },
    {
      name: '（待補）',
      title: '碳盤查小組 召集人',
      role: 'carbon-audit-convener',
      bio: '負責 ISO 14064-1 溫室氣體盤查、查證輔導與方法學研究。',
    },
    {
      name: '（待補）',
      title: '社區健康管理組 召集人',
      role: 'community-health-convener',
      bio: '負責推動社區永續健康、社會責任實踐與利害關係人溝通。',
    },
    {
      name: '（待補）',
      title: '教育訓練組 召集人',
      role: 'training-convener',
      bio: '負責舉辦 ESG 研討會、專業證照培訓與人才養成。',
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const chairmanSrc = readSourceFile('葉蔭民 理事長.md');
const chairmanBio = parseChairmanBio(chairmanSrc);

const team = buildTeam(chairmanBio);

writeDataFile('team.yaml', team);
console.log(`Done. ${team.length} team members written to data/team.yaml`);
