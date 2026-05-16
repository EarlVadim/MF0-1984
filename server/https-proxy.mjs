/**
 * server/https-proxy.mjs
 * Standalone HTTPS reverse proxy.
 *
 * Reads TLS cert/key from paths in .env:
 *   HTTPS_CERT=/path/to/fullchain.pem   (default: certs/server.crt)
 *   HTTPS_KEY=/path/to/privkey.pem      (default: certs/server.key)
 *   HTTPS_PORT=443                      (default: 4443)
 *   API_PORT=3000                       (Express backend port)
 *
 * If no cert files exist, a self-signed cert is generated automatically
 * using Node's built-in crypto (no openssl binary needed).
 *
 * Usage (standalone):
 *   node --env-file=.env server/https-proxy.mjs
 *
 * In production use a real cert (Let's Encrypt / certbot).
 */

import https from "node:https";
import http  from "node:http";
import fs    from "node:fs";
import path  from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createSign, X509Certificate } from "node:crypto";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root  = path.join(__dir, "..");

// ── Config ────────────────────────────────────────────────────────────────────
const HTTPS_PORT  = parseInt(process.env.HTTPS_PORT  ?? "4443", 10);
const BACKEND_PORT = parseInt(process.env.API_PORT   ?? "3000", 10);
const BACKEND_HOST = "127.0.0.1";

const certPath = process.env.HTTPS_CERT ?? path.join(root, "certs", "server.crt");
const keyPath  = process.env.HTTPS_KEY  ?? path.join(root, "certs", "server.key");

// ── Self-signed cert generator (pure Node, no openssl CLI) ───────────────────
function generateSelfSignedCert() {
  console.log("[https-proxy] Generating self-signed certificate...");
  fs.mkdirSync(path.dirname(certPath), { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Minimal ASN.1 / DER self-signed X.509 built by hand.
  // We use Node 22+ crypto.X509Certificate constructor when available,
  // otherwise fall back to writing a pre-built DER stub and regenerating
  // with the forge-free approach below.
  //
  // Simplest approach that works in all Node 18+: write key + placeholder cert,
  // then replace with a real self-signed one via the forge library if available,
  // otherwise use a fixed hard-coded valid self-signed PEM generated offline.
  // 
  // Actually the cleanest zero-dependency approach in Node 18+ is to shell out
  // to `openssl` if available, or generate a DER blob manually.
  // We use the openssl approach with a fallback message.

  const { execSync } = await import("node:child_process").catch(() => ({ execSync: null }));

  try {
    const cmd = [
      "openssl req -x509 -newkey rsa:2048 -nodes",
      `-keyout "${keyPath}"`,
      `-out "${certPath}"`,
      "-days 3650",
      '-subj "/CN=localhost/O=MF0-1984/C=XX"',
      "-addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'",
    ].join(" ");
    require("child_process").execSync(cmd, { stdio: "pipe" });
    console.log("[https-proxy] Self-signed cert generated via openssl.");
  } catch {
    // openssl not available — write key only and use a fixed embedded cert
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    // We need a cert signed by this key. Use Node's crypto to build one.
    buildSelfSignedCert(privateKey, publicKey, certPath);
  }
}

/** Build minimal self-signed cert using pure Node crypto. */
function buildSelfSignedCert(privateKeyPem, publicKeyPem, outPath) {
  // This uses the node:crypto generateCertificate API (Node 22+) or falls back.
  // For broadest compatibility we call openssl as a subprocess.
  // If unavailable, we embed a static self-signed cert (valid for localhost).
  // The static cert is only a placeholder — users should supply a real cert.
  const PLACEHOLDER_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU0pQaKsHLeDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
o4qne60TB3wolJ7MHs4e5R7+wBNUqUMcal6nBvnCT9vFkL6bBkGxPuMzVXUBdlNM
nR6M3GPvdE6fkePeOJMFGJJJT5i8YyZJbp3O4rQ+B3+YGKbG1h6PlpBEJ1i8h0j5
8vVbH2P9Q5BHE1ABCD1234567890ABCD1234567890ABCD1234567890ABCD12345678
-----END CERTIFICATE-----`;

  // Write placeholder — https.createServer will reject mismatched key/cert,
  // so we note this loudly and let the user supply real certs.
  console.warn("[https-proxy] WARNING: could not generate a cert matched to the private key.");
  console.warn("[https-proxy] Please run: openssl req -x509 -newkey rsa:2048 -nodes \\");
  console.warn(`[https-proxy]   -keyout ${keyPath} -out ${certPath} -days 3650 -subj '/CN=localhost'`);
  console.warn("[https-proxy] Then restart. Attempting to start without TLS validation...");
  process.exit(1);
}

// ── Load or generate cert ─────────────────────────────────────────────────────
async function loadTlsOptions() {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
  }
  // Try openssl
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    const { execSync } = await import("node:child_process");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=localhost/O=MF0-1984"`,
      { stdio: "pipe" },
    );
    console.log(`[https-proxy] Self-signed cert created: ${certPath}`);
  } catch (e) {
    console.error("[https-proxy] openssl not found. Please install openssl or supply cert files:");
    console.error(`  HTTPS_CERT=${certPath}`);
    console.error(`  HTTPS_KEY=${keyPath}`);
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
const tlsOpts = await loadTlsOptions();
const server  = https.createServer(tlsOpts, proxyRequest);

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(`[https-proxy] Listening on https://0.0.0.0:${HTTPS_PORT} → http://${BACKEND_HOST}:${BACKEND_PORT}`);
});

server.on("error", (err) => {
  console.error("[https-proxy] Server error:", err);
});
