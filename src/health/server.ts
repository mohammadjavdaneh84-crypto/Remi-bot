import { createServer } from 'node:http';
export function healthServer(isReady: () => Promise<boolean>, version: string) {
  return createServer((req, res) => {
    void (async () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/healthz') {
        res.end('{"status":"alive"}');
        return;
      }
      if (req.url === '/version') {
        res.end(JSON.stringify({ version }));
        return;
      }
      if (req.url !== '/readyz') {
        res.statusCode = 404;
        res.end('{"status":"not_found"}');
        return;
      }
      let ready = false;
      try {
        ready = await isReady();
      } catch {
        /* dependency unavailable */
      }
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
    })();
  });
}
