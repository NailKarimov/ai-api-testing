// fx-mcp over Streamable HTTP for manual exploration: npm run mcp:http → http://127.0.0.1:3333/mcp
// Tokens: dev-read (fx:read), dev-admin (fx:read fx:admin).
import { buildHttpServer } from './http.ts';

const app = buildHttpServer({ tokens: { 'dev-read': ['fx:read'], 'dev-admin': ['fx:read', 'fx:admin'] } });
const base = await app.listen(Number(process.env.PORT ?? 3333));
console.error(`fx-mcp on ${base}/mcp (tokens dev-read, dev-admin)`);
