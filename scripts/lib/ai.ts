import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();  // reads ANTHROPIC_API_KEY from env

export async function generateContent(
  prompt: string,
  systemPrompt: string = 'You are a professional content writer for 國際醫療減碳協會 (International Medical Carbon Reduction Association). Write in 繁體中文. Use Taiwan terminology, not China terminology.',
  model: string = 'claude-sonnet-4-20250514',
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
