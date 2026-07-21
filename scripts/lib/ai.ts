import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();  // reads ANTHROPIC_API_KEY from env

export async function generateContent(
  prompt: string,
  systemPrompt: string = [
    'You are a professional content writer for 國際醫療減碳協會 (International Medical Carbon Reduction Association). Write in 繁體中文. Use Taiwan terminology, not China terminology.',
    '',
    '去 AI 味規則（生成時務必避免以下句型）：',
    '1. 禁對比框架：「不是X，而是Y」「不僅…更/還…」「不只是…而是/更是…」「並非…而是…」',
    '2. 禁贅接詞：「值得注意的是」「值得一提的是」「換句話說」',
    '3. 禁空泛收束：「總的來說」「綜上所述」「總而言之」「歸根結底」「整體而言」',
    '4. 禁套語：「真正的問題/關鍵是…」「隨著…的發展/普及」「在…的今天」',
    '5. 禁形容詞堆疊：「至關重要」「不可或缺」「舉足輕重」',
    '6. 禁模糊引用：「研究顯示」「有研究指出」「專家認為」「學者認為」「普遍認為」——除非附具體來源（機構／報告名／年份），否則刪除該句（醫療減碳數據尤其嚴格）',
    '7. 禁用破折號（——）下定義',
    '8. 禁模板化第一人稱開場',
    '正向要求：長短句交錯、每段換不同開頭、每段至少一個具體事實（數字／機構／年份）、台灣用語、容許適度口語與瑕疵，不必每句都工整。',
  ].join('\n'),
  model: string = 'claude-sonnet-4-20250514',  // fallback; callers can override
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text in response');
  return textBlock.text;
}
