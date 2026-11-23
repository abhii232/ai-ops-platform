require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require('@google/genai');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest'];
const MAX_HISTORY = 10;
const ADMIN_KEY = process.env.ADMIN_KEY;

const INTENTS = ['billing', 'technical_issue', 'refund', 'escalation', 'general'];
const REVIEW_THRESHOLD = 0.7;

app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT =
  'You are a friendly, concise customer support assistant. ' +
  'Answer clearly in 1-3 short sentences. If you do not know something, say so. ' +
  'You cannot transfer calls or connect people live. If the customer asks for a manager or a human, ' +
  'say their request has been flagged for a team member to follow up, and never claim someone is joining now. ' +
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

// Admin endpoints need the x-admin-key header. If ADMIN_KEY is not set, they stay locked.
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Tries each model once, moving to the next immediately on a temporary
// error (503 overloaded, 429 rate limit, 404 retired model, network failure).
async function generateWithFallback(params) {
  const models = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
  let lastError;

  for (const model of models) {
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({ ...params, model });
      console.log(`Gemini ${model} answered in ${Date.now() - started} ms`);
      return response;
    } catch (error) {
      lastError = error;
      const msg = String(error.message || '');
      const skipModel =
        error.status === 503 ||
        error.status === 429 ||
        error.status === 404 ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('NOT_FOUND') ||
        msg.includes('fetch failed');
      console.warn(`Gemini ${model} failed after ${Date.now() - started} ms (skip: ${skipModel})`);
      if (!skipModel) throw error;
    }
  }
  throw lastError;
}

app.get('/', (req, res) => {
  res.send('Server is running!');
});

app.post('/chat', async (req, res) => {
  const requestStart = Date.now();
  try {
    const { message, history = [], conversationId = null } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const contents = [
      ...history.slice(-MAX_HISTORY).map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const response = await generateWithFallback({
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: 400,
      },
    });

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
    const needsReview = confidence < REVIEW_THRESHOLD;

    // Save to the database. If this fails, the customer still gets their reply.
    let savedConversationId = conversationId;
    try {
      if (!savedConversationId) {
        const created = await pool.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
        savedConversationId = created.rows[0].id;
      }
      await pool.query(
        `INSERT INTO messages (conversation_id, role, text, intent, confidence, needs_review)
         VALUES ($1, 'user', $2, $3, $4, $5),
                ($1, 'assistant', $6, NULL, NULL, FALSE)`,
        [savedConversationId, message, intent, confidence, needsReview, reply]
      );
    } catch (dbError) {
      console.error('Could not save to database:', dbError.message);
      savedConversationId = null;
    }

    console.log(`/chat total ${Date.now() - requestStart} ms`);
    res.json({
      reply,
      intent,
      confidence,
      needsReview,
      conversationId: savedConversationId,
    });
  } catch (error) {
    console.error('Error calling Gemini:', error.message);
    res.status(500).json({ error: 'Something went wrong calling the AI model' });
  }
});

// Admin: list the 50 most recent conversations
app.get('/conversations', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id,
             c.created_at,
             COUNT(m.id)::int AS message_count,
             BOOL_OR(m.needs_review) AS needs_review,
             (ARRAY_AGG(m.text ORDER BY m.id) FILTER (WHERE m.role = 'user'))[1] AS first_message
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('Could not list conversations:', error.message);
    res.status(500).json({ error: 'Could not load conversations' });
  }
});

// Admin: all messages in one conversation
app.get('/conversations/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, role, text, intent, confidence, needs_review, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Could not load messages:', error.message);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});