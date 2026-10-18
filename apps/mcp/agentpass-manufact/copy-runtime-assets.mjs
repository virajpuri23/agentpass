import { cpSync } from 'node:fs';
// The server bundle relocates import.meta.url; keep checksum-verified SQL beside it.
cpSync(new URL('../../../db/migrations/',import.meta.url),new URL('./.mcp-use/build/migrations/',import.meta.url),{recursive:true});
