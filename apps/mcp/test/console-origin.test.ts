import {it,expect} from 'vitest';
import {atConsoleOrigin} from '../src/console-origin.js';
it('normalizes an internal proxy URL while preserving method, body and browser Origin',async()=>{
 const request=new Request('http://0.0.0.0:3000/console-api/session',{method:'POST',headers:{origin:'https://agentpass.example','content-type':'application/json',host:'internal', 'x-forwarded-host':'untrusted.example'},body:'{"credential":"fixture"}'});
 const normalized=atConsoleOrigin(request,'https://agentpass.example');
 expect(normalized.url).toBe('https://agentpass.example/console-api/session');expect(normalized.method).toBe('POST');expect(normalized.headers.get('origin')).toBe('https://agentpass.example');expect(await normalized.text()).toBe('{"credential":"fixture"}');
});
it('never derives the target origin from the path, proxy headers or claimed browser Origin',()=>{
 const normalized=atConsoleOrigin(new Request('http://internal//evil.example/path?x=1',{headers:{origin:'https://evil.example','x-forwarded-host':'evil.example'}}),'https://agentpass.example');
 expect(new URL(normalized.url).origin).toBe('https://agentpass.example');expect(new URL(normalized.url).pathname).toBe('//evil.example/path');expect(normalized.headers.get('origin')).toBe('https://evil.example');
});
