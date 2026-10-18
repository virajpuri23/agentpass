import express from 'express';
import { createConsoleHandler } from './handler.js';
const port = Number(process.env.CONSOLE_PORT ?? 3000);
const origin = process.env.CONSOLE_ORIGIN ?? `http://127.0.0.1:${port}`;
if (!process.env.AUTHORITY_URL || !process.env.MCP_PUBLIC_URL) throw new Error('AUTHORITY_URL and MCP_PUBLIC_URL are required.');
const handle = createConsoleHandler({authorityUrl:process.env.AUTHORITY_URL,mcpUrl:process.env.MCP_PUBLIC_URL,origin});
const app = express();
app.disable('x-powered-by');
app.use(express.text({type:'application/json',limit:'32kb'}));
app.use(async (req,res) => {
  const headers = new Headers();
  for (const [key,value] of Object.entries(req.headers)) if (typeof value==='string') headers.set(key,value);
  const response = await handle(new Request(new URL(req.originalUrl,origin),{method:req.method,headers,...(req.method==='POST'?{body:req.body}: {})}));
  response.headers.forEach((value,key) => res.setHeader(key,value));
  res.status(response.status).send(await response.text());
});
app.listen(port,'127.0.0.1',() => console.log(`AgentPass console: ${origin}/connect`));
