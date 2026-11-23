// Tiny HTTP server for Render's $PORT.
//  - GET /health  -> 200 {"ok":true}  (Render health check + UptimeRobot ping)
//  - anything else -> reverse-proxy to 9Router on 127.0.0.1:20128
//    (so the dashboard + /v1 API are reachable via the onrender.com URL
//    as a fallback when the Cloudflare Tunnel is down).
// No dependencies, Node stdlib only.
const http = require('http');

const PORT = parseInt(process.env.PORT || '10000', 10);
const ROUTER_PORT = parseInt(process.env.ROUTER_PORT || '20128', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: '9router-gateway', time: new Date().toISOString() }));
    return;
  }
  // Reverse proxy to 9Router.
  const proxy = http.request(
    {
      host: '127.0.0.1',
      port: ROUTER_PORT,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + ROUTER_PORT }),
    },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    }
  );
  proxy.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '9router not reachable: ' + e.message }));
  });
  req.pipe(proxy);
});

server.listen(PORT, () => {
  console.log(new Date().toISOString(), 'health proxy listening on port', PORT, '-> 9Router :' + ROUTER_PORT);
});
