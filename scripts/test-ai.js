require('dotenv').config();
const OpenAI = require('openai');

const ai = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
});

async function test() {
  console.log('Testing with API Key:', process.env.AI_API_KEY ? process.env.AI_API_KEY.slice(0, 10) + '...' : 'NONE');
  console.log('Configured Model:', process.env.AI_MODEL);

  const models = [
    process.env.AI_MODEL || 'llama-3.3-70b-versatile',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant'
  ];

  for (const model of [...new Set(models)]) {
    console.log(`\n--- Testing model: ${model} ---`);
    try {
      const res = await ai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: 'Xin chào, hãy trả lời 1 câu ngắn.' }],
      });
      console.log(`SUCCESS with ${model}:`, res.choices[0].message.content);
      break;
    } catch (err) {
      console.error(`FAILED with ${model}:`, err.status, err.message);
    }
  }
}

test();
