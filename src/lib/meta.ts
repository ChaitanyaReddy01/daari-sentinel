import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is not set');

export const meta = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey });
