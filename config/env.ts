import 'dotenv/config';

/** Test environment settings. Nothing here is secret. */
export const env = {
  /** Base URL of an OpenAI-compatible LLM endpoint (Ollama in CI); empty → the LLM suite is skipped. */
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
};
