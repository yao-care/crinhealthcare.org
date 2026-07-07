export function generateOgSvg(title: string, collection: string): string {
  const colors: Record<string, string> = {
    news: '#1a6b64',
    insights: '#2d8a5e',
    'case-studies': '#b8860b',
    glossary: '#4a6fa5',
    services: '#5a9e96',
    website: '#1a6b64',
  };
  const color = colors[collection] ?? colors.website;

  // Truncate title to ~50 chars for display
  const displayTitle = title.length > 50 ? title.slice(0, 48) + '...' : title;

  // Category labels
  const labels: Record<string, string> = {
    news: '新聞',
    insights: '深度內容',
    'case-studies': '案例故事',
    glossary: '詞彙庫',
    services: '服務項目',
    website: '',
  };
  const label = labels[collection] ?? '';

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="630" fill="white"/>
    <rect width="1200" height="8" fill="${color}"/>
    <text x="60" y="80" font-family="'Noto Sans CJK TC','Noto Sans TC',sans-serif" font-size="20" fill="#666">國際醫療減碳協會</text>
    <text x="60" y="340" font-family="'Noto Sans CJK TC','Noto Sans TC',sans-serif" font-size="48" font-weight="bold" fill="#1a1a1a">${escapeXml(displayTitle)}</text>
    ${label ? `<rect x="60" y="520" width="${label.length * 24 + 32}" height="36" rx="6" fill="${color}"/>
    <text x="76" y="544" font-family="'Noto Sans CJK TC','Noto Sans TC',sans-serif" font-size="18" fill="white">${label}</text>` : ''}
    <text x="1140" y="590" font-family="sans-serif" font-size="16" fill="#999" text-anchor="end">crinhealthcare.org</text>
  </svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
