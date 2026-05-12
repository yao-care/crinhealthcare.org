import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const text = `# 國際醫療減碳協會 (CRIN Healthcare)

> 協助醫療院所達成淨零排放的非營利組織

## 服務項目
- 公益 ISO 14064-1 碳盤查
- 主迴路能源管理系統 (EMS)
- ESG 永續報告書輔導
- 永續暨節能減碳獎項申請
- 政府補助計畫申請
- 健康台灣深耕計畫（範疇四）

## 聯絡資訊
- 網站: https://crinhealthcare.org
- 加入會員: https://crinhealthcare.org/join/

## 更多資訊
- 詞彙庫: https://crinhealthcare.org/glossary/
- 深度內容: https://crinhealthcare.org/insights/
- 合作成果: https://crinhealthcare.org/results/
- 完整內容: https://crinhealthcare.org/llms-full.txt
`;

  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
