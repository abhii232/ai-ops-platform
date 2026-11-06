require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT =
  'You are a friendly, concise customer support assistant. ' +
  'Answer clearly in 1-3 sentences. If you do not know something, say so.';

app.get('/', (req, res) => {
  res.send('Server is running!');
});

// Helper: lists model names your key can use
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

    // Convert our history format to Gemini's format
    const contents = [
      ...history.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT },
    });

    res.json({ reply: response.text });
  } catch (error) {
    console.error('Error calling Gemini:', error.message);
    res.status(500).json({ error: 'Something went wrong calling the AI model' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});