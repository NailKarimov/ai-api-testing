// fx-assistant by hand: ANTHROPIC_API_KEY=… npm run llm:dev → POST http://127.0.0.1:3400/v1/answer {"question":"…"}
import { buildAssistantServer } from './http.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY (for example in .env, which git ignores).');
  process.exit(1);
}
const app = buildAssistantServer({ apiKey });
console.error(`fx-assistant on ${await app.listen(Number(process.env.PORT ?? 3400))}/v1/answer`);
