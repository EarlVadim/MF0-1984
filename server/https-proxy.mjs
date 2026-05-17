/**
 * server/https-proxy.mjs
 * Standalone HTTPS reverse proxy for MF0-1984.
 *
 * Reads TLS cert/key from .env:
 *   HTTPS_CERT=/path/to/fullchain.pem   (default: certs/server.crt)
 *   HTTPS_KEY=/path/to/privkey.pem      (default: certs/server.key)
 *   HTTPS_PORT=4443                     (default: 4443)
 *   API_PORT=35184                      (Vite preview backend port, default 1984)
 *
 * Proxies all traffic: HTTPS:HTTPS_PORT → HTTP:BACKEND_PORT (Vite preview).
 * Vite preview in turn proxies /api/* → Express API.
 */

import https   from "node:https";
import http    from "node:http";
import fs      from "node:fs";
import path    from "node:path";
import { execSync }      from "node:child_process";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root  = path.join(__dir, "..");

// ── Config ────────────────────────────────────────────────────────────────────
const HTTPS_PORT   = parseInt(process.env.HTTPS_PORT ?? "4443", 10);
const BACKEND_PORT = parseInt(process.env.VITE_PORT  ?? "1984", 10);
const BACKEND_HOST = "127.0.0.1";

const certPath = process.env.HTTPS_CERT ?? path.join(root, "certs", "server.crt");
const keyPath  = process.env.HTTPS_KEY  ?? path.join(root, "certs", "server.key");

// ── Load or generate TLS cert ─────────────────────────────────────────────────
function loadTlsOptions() {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log(`[https-proxy] Loading cert: ${certPath}`);
    return {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
  }

  // Try to generate a self-signed cert via openssl (fallback only)
  console.warn("[https-proxy] Cert files not found, attempting self-signed generation...");
  fs.mkdirSync(path.dirname(certPath), { recursive: true });

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes` +
      ` -keyout "${keyPath}"` +
      ` -out "${certPath}"` +
      ` -days 3650` +
      ` -subj "/CN=localhost/O=MF0-1984"`,
      { stdio: "pipe" },
    );
    console.log(`[https-proxy] Self-signed cert created: ${certPath}`);
  } catch {
    console.error("[https-proxy] ERROR: cert files missing and openssl unavailable.");
    console.error(`  Set HTTPS_CERT and HTTPS_KEY in .env, or place files at:`);
    console.error(`  ${certPath}`);
    console.error(`  ${keyPath}`);
    process.exit(1);
  }

  return {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  };
}

// ── Proxy handler ─────────────────────────────────────────────────────────────
function proxyRequest(clientReq, clientRes) {
  const options = {
    hostname: BACKEND_HOST,
    port:     BACKEND_PORT,
    path:     clientReq.url,
    method:   clientReq.method,
    headers:  {
      ...clientReq.headers,
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For":   clientReq.socket.remoteAddress ?? "",
      host: `${BACKEND_HOST}:${BACKEND_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[https-proxy] upstream error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end("Bad Gateway");
    }
  });

  clientReq.pipe(proxyReq, { end: true });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const tlsOpts = loadTlsOptions();
const server  = https.createServer(tlsOpts, proxyRequest);

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(
    `[https-proxy] https://0.0.0.0:${HTTPS_PORT} → http://${BACKEND_HOST}:${BACKEND_PORT}`
  );
});

server.on("error", (err) => {
  if (err.code === "EACCES") {
    console.error(`[https-proxy] Permission denied on port ${HTTPS_PORT}. Run as root or use port > 1024.`);
  } else if (err.code === "EADDRINUSE") {
    console.error(`[https-proxy] Port ${HTTPS_PORT} already in use.`);
  } else {
    console.error("[https-proxy] Server error:", err);
  }
  process.exit(1);
});
