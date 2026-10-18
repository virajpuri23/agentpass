// Hosted adapters may construct an internal request URL. The configured origin is the trust anchor.
export function atConsoleOrigin(request: Request, origin: string) {
  const incoming=new URL(request.url);
  const target=new URL(new URL(origin).origin);
  target.pathname=incoming.pathname;
  target.search=incoming.search;
  return new Request(target,request);
}
