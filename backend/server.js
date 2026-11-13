require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const INTENTS = ['billing', 'technical_issue', 'refund', 'escalation', 'general'];
const REVIEW_THRESHOLD = 0.7;

app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT =
  'You are a friendly, concise customer support assistant. ' +
  'Answer clearly in 1-3 sentences. If you do not know something, say so. ' +
  "For every turn, also classify the intent of the customer's LATEST message as one of: " +
  INTENTS.join(', ') +
  '. Give a confidence between 0 and 1. Use a LOW confidence if the message is vague or ambiguous.';

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reply: { type: Type.STRING },
    intent: { type: Type.STRING, enum: INTENTS },
    confidence: { type: Type.NUMBER },
  },
  required: ['reply', 'intent', 'confidence'],
};

// Retries temporary Gemini errors (503 overloaded / 429 rate limit),
// then falls back to other models if the main one keeps failing.
async function generateWithRetry(params) {
  const models = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (error) {
        lastError = error;
        const msg = String(error.message || '');
        const temporary =
          error.status === 503 ||
          error.status === 429 ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('RESOURCE_EXHAUSTED');
        console.warn(`Gemini ${model} attempt ${attempt} failed (temporary: ${temporary})`);
        if (!temporary) throw error;
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
  }
  throw lastError;
}

app.get('/', (req, res) => {
  res.send('Server is running!');
});

app.get('/models', async (req, res) => {
  try {
    const names = [];
    const pager = await ai.models.list();
    for await (const m of pager) {
      names.push(m.name);
    }
    res.json({ models: names.filter((n) => n.includes('flash')) });
  } catch (error) {
    console.error('Error listing models:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const contents = [
      ...history.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const response = await generateWithRetry({
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    // Parse the structured answer; fall back safely if it is malformed
    let reply = response.text;
    let intent = 'general';
    let confidence = 0;
    try {
      const parsed = JSON.parse(response.text);
      reply = parsed.reply;
      intent = INTENTS.includes(parsed.intent) ? parsed.intent : 'general';
      confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    } catch {
      console.warn('Could not parse structured output, using fallback');
    }

    res.json({
      reply,
      intent,
      confidence,
      needsReview: confidence < REVIEW_THRESHOLD,
    });
  } catch (error) {
    console.error('Error calling Gemini:', error.message);
    res.status(500).json({ error: 'Something went wrong calling the AI model' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});