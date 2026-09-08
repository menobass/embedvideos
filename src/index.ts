import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { startTusd } from './utils/tusd';
import { validateUploadAuth } from './utils/uploadAuth';
import busboy from 'busboy';
import path from 'path';
import { unlinkSync, statfsSync, createWriteStream, promises as fsp } from 'fs';
import { randomBytes } from 'crypto';
import { Database, Encoder, JobStatus, VideoMetadata } from './database/mongodb';
import { generateVideoId } from './utils/videoId';
import { generateApiKey } from './utils/keyGenerator';
import { createApiKeyMiddleware } from './middleware/auth';
import { createAdminAuthMiddleware } from './middleware/adminAuth';
import { loadConfig } from './config/config';
import { pinFile, unpinFile, announceDHT } from './utils/ipfs';
import { JobDispatcher } from './dispatcher/jobDispatcher';
import { unwrapJWS, JWSAuthError } from './utils/jws';
import { CleanupService } from './utils/cleanup';
import { signUploadToken, verifyUploadToken, generateTokenId, UploadTokenClaims } from './utils/uploadToken';
import { registerGatedVideo, isGateConfigured, verifyGatedManifestEncrypted } from './utils/gate';

dotenv.config();

const app = express();
const config = loadConfig();

/**
 * How long a finalize token stays valid, and therefore how long a deferred
 * upload can sit unfinished before its encode can no longer be commissioned.
 * Long enough to survive a slow details step; short enough that an abandoned
 * upload's pinned input does not linger indefinitely. Paired with
 * DEFERRED_ENCODE_ABANDON_HOURS below, which does the actual cleanup.
 */
const FINALIZE_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Deferred uploads that never got a publish are swept after this long. */
const DEFERRED_ENCODE_ABANDON_HOURS = 12;

// Trust proxy to get correct protocol from X-Forwarded-Proto
app.set('trust proxy', true);

// Initialize database
const database = new Database(config.mongoUri, config.mongoDbName, config.mongoCollectionVideos);

// Initialize cleanup service
const cleanupService = new CleanupService(config.uploadDir, config.cleanupRetentionDays);

// Middleware
app.use(cors({
  exposedHeaders: ['X-Embed-URL', 'x-embed-url'],
  // Every chunk POST carries an upload progress listener, which makes it a
  // non-simple request, which makes the browser preflight it. With no Max-Age
  // Chrome caches that preflight for 5 SECONDS, so the chunked path was paying a
  // full extra round trip per chunk: 923 preflights for 931 chunk POSTs measured
  // over two days. On a 250ms mobile RTT that is most of a second per chunk, spent
  // on links that have none to spare. 600 is Chrome's ceiling; it ignores more.
  maxAge: 600,
}));
app.use(express.json());

// Increase timeout for TUS upload routes (default Node.js timeout is ~2min, videos need more)
app.use('/uploads', (req, res, next) => {
  res.setTimeout(30 * 60 * 1000); // 30 minutes
  next();
});

app.use(express.static('public'));

// Create auth middleware
const requireApiKey = createApiKeyMiddleware(database);
const requireAdminAuth = createAdminAuthMiddleware(config);

// Proxy /uploads to tusd — tusd handles TUS protocol, Concatenation extension, and parallel chunks.
// Use app.all (not app.use) so Express does NOT strip the /uploads prefix before forwarding.
// tusd v2 ignores HTTPResponse.Headers from hook responses entirely.
// We inject X-Embed-URL ourselves in proxyRes using two stores:
//   pending201EmbedUrls — FIFO queue: pushed in pre-create, consumed by the next 201
//   pending204EmbedUrls — Map by upload ID: set in pre-finish, consumed by the 204
const pending201EmbedUrls: string[] = [];
const pending204EmbedUrls = new Map<string, string>();

// app.use strips the mount path from req.url; app.all preserves it — tusd needs the full path.
const tusProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${config.tusdPort}`,
  changeOrigin: false,
  xfwd: true,
  proxyTimeout: 30 * 60 * 1000,
  on: {
    proxyReq: (proxyReq, req) => {
      // xfwd appends ",http" to nginx's X-Forwarded-Proto. Fix: forward only the first value.
      const proto = req.headers['x-forwarded-proto'];
      if (proto) {
        const first = (Array.isArray(proto) ? proto[0] : proto).split(',')[0].trim();
        proxyReq.setHeader('X-Forwarded-Proto', first);
      }
    },
    proxyRes: (proxyRes, req) => {
      // Inject X-Embed-URL into the 201 (upload creation) for browser tus-js-client
      if (proxyRes.statusCode === 201 && pending201EmbedUrls.length > 0) {
        proxyRes.headers['x-embed-url'] = pending201EmbedUrls.shift()!;
      }
      // Inject X-Embed-URL into the 204 (upload complete) for mobile SDKs
      if (proxyRes.statusCode === 204) {
        const uploadId = (req.url || '').split('/').filter(Boolean).pop() || '';
        const embedUrl = pending204EmbedUrls.get(uploadId);
        if (embedUrl) {
          proxyRes.headers['x-embed-url'] = embedUrl;
          pending204EmbedUrls.delete(uploadId);
        }
      }
      const existing = (proxyRes.headers['access-control-expose-headers'] as string) || '';
      if (!existing.toLowerCase().includes('x-embed-url')) {
        proxyRes.headers['access-control-expose-headers'] =
          existing ? `${existing}, X-Embed-URL` : 'X-Embed-URL';
      }
    },
  },
});
// /uploads/token must be registered before the tusd proxy wildcard.
// app.all('/uploads/*') would otherwise swallow POST /uploads/token and
// forward it to tusd, which returns 412 (TUS Precondition Failed).
app.post('/uploads/token', requireApiKey, async (req: Request, res: Response) => {
  try {
    if (!config.uploadTokenSecret) {
      return res.status(503).json({
        error: 'Upload tokens are not configured',
        message: 'Set UPLOAD_TOKEN_SECRET to enable upload tokens',
      });
    }

    const {
      owner, frontend_app, short = false, gated = false, allowlist,
      allowed_origins = [], max_file_size, ttl, defer_encode = false,
    } = req.body;

    if (!owner || typeof owner !== 'string') {
      return res.status(422).json({ error: 'owner (string) is required' });
    }

    // 🔐 Gated (paid) uploads are a 3Speak Pro capability. This is the ONLY
    // place the gated flag can be granted, because it is the only place with a
    // verified owner and a signing key. Everything downstream reads it from the
    // signed claim rather than from client-supplied metadata.
    if (gated) {
      if (typeof gated !== 'boolean') {
        return res.status(422).json({ error: 'gated must be a boolean' });
      }
      // Refuse up front rather than accepting an upload that can never be
      // played: without a gate, the finished video has nowhere to register and
      // no viewer, creator included, can ever obtain a key for it.
      if (!isGateConfigured(config)) {
        console.error('Gated upload requested but GATE_URL / GATE_INTERNAL_API_KEY are not set');
        return res.status(503).json({
          error: 'Gated uploads are not available on this instance',
          code: 'gate_not_configured',
        });
      }
      // Guest list: named accounts that watch without Pro. Validated here, the
      // one place with a verified owner and a signing key. Never written to the
      // Hive post, so the recipient list is not published on-chain.
      if (allowlist !== undefined) {
        if (!Array.isArray(allowlist) || allowlist.length > 500) {
          return res.status(422).json({ error: 'allowlist must be an array of at most 500 usernames' });
        }
        const bad = allowlist.find(
          (u: unknown) => typeof u !== 'string' || !/^[a-z][a-z0-9.-]{2,15}$/.test(String(u).trim().toLowerCase().replace(/^@/, ''))
        );
        if (bad !== undefined) {
          return res.status(422).json({ error: `"${bad}" is not a valid Hive account name` });
        }
      }

      const isPro = await database.isUserPremium(owner);
      if (!isPro) {
        console.warn(`Gated upload token refused for non-Pro user: ${owner}`);
        return res.status(403).json({
          error: 'Gated uploads require 3Speak Pro',
          code: 'pro_required',
        });
      }
    }

    const tokenTtl = Math.min(
      typeof ttl === 'number' && ttl > 0 ? ttl : config.uploadTokenDefaultTtl,
      config.uploadTokenMaxTtl
    );

    const maxFileSize = typeof max_file_size === 'number' && max_file_size > 0
      ? Math.min(max_file_size, config.uploadTokenMaxFileSize)
      : config.uploadTokenMaxFileSize;

    const now = Math.floor(Date.now() / 1000);
    const apiKeyData = (req as any).apiKey;

    // Assign the permlink here, at token issuance, and bind it to the token.
    // The client receives it in the response (permlink/embed_url below) and can
    // build the canonical embed URL without scraping a TUS response header —
    // which is what makes parallel/Concatenation uploads reliable.
    const permlink = generateVideoId();

    const claims: UploadTokenClaims = {
      jti: generateTokenId(),
      owner,
      app: frontend_app || apiKeyData?.app_name || 'unknown',
      issuedByKey: apiKeyData?.app_name || 'unknown',
      short: !!short,
      gated: !!gated,
      ...(defer_encode ? { deferEncode: true } : {}),
      ...(gated && Array.isArray(allowlist) && allowlist.length
        ? { allowlist: [...new Set(allowlist.map((u: string) => String(u).trim().toLowerCase().replace(/^@/, '')))] }
        : {}),
      maxFileSize,
      allowedOrigins: Array.isArray(allowed_origins) ? allowed_origins : [],
      permlink,
      iat: now,
      exp: now + tokenTtl,
    };

    const token = signUploadToken(claims, config.uploadTokenSecret);
    const expiresAt = new Date(claims.exp * 1000).toISOString();
    const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;

    // A deferred upload needs a second credential to commission its encode
    // later. It outlives the upload token deliberately: the upload takes
    // seconds, but the user may sit on the details step for a long time, and an
    // expired finalize token would strand a file that is already uploaded.
    const finalizeToken = defer_encode
      ? signUploadToken(
        {
          ...claims,
          jti: generateTokenId(),
          scope: 'finalize',
          // Carries no upload rights of its own, and validateUploadAuth
          // rejects it outright, but zero these anyway so a bug that reached
          // for them cannot find a usable allowance.
          maxFileSize: 0,
          gated: false,
          allowlist: [],
          iat: now,
          exp: now + FINALIZE_TOKEN_TTL_SECONDS,
        },
        config.uploadTokenSecret,
      )
      : undefined;

    console.log(`Upload token issued: ${owner}/${permlink} via ${claims.app} (ttl=${tokenTtl}s, jti=${claims.jti.slice(0, 8)}...)`);

    res.status(201).json({
      success: true,
      token,
      upload_url: `${req.protocol}://${req.get('host')}/uploads`,
      permlink,
      embed_url: embedUrl,
      expires_at: expiresAt,
      // Echoed back so a client can confirm the flag was honoured. An instance
      // running older code simply omits this, which lets the frontend refuse to
      // upload rather than silently publishing a "paid" video in the clear.
      gated: !!gated,
      // Echoed for the same reason: an instance without deferred encoding omits
      // both fields, so a client that needs the gated decision to happen after
      // the upload can detect it instead of quietly losing the choice.
      defer_encode: !!defer_encode,
      ...(finalizeToken ? { finalize_token: finalizeToken } : {}),
    });
  } catch (error) {
    console.error('Error creating upload token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Simple (non-resumable) single-request upload ---------------------------
// Fallback for clients where the TUS PATCH flow is blocked (some mobile carriers
// / WebViews). ONE multipart POST, whole file in the body, NO resume.
//
// Auth: an upload token passed as a FORM FIELD (keeps the request a plain
// multipart POST with no custom headers -> no CORS preflight), OR an X-API-Key
// header for server-to-server callers.
//
// FormData contract — the client MUST append the token/metadata fields BEFORE
// the file part so we can authenticate as early as possible:
//   token     upload token from POST /uploads/token   (or send X-API-Key header)
//   filename  original filename (optional; falls back to the multipart filename)
//   duration  seconds (optional)
//   file      the video file — LAST part
app.post('/upload/simple', (req: Request, res: Response) => {
  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { files: 1, fields: 15, fileSize: config.maxUploadSize },
    });
  } catch {
    return res.status(400).json({ error: 'Expected multipart/form-data' });
  }

  const fields: Record<string, string> = {};
  let tempPath: string | null = null;
  let receivedSize = 0;
  let tooBig = false;
  let responded = false;
  let filePromise: Promise<void> = Promise.resolve();

  const cleanup = () => { if (tempPath) { try { unlinkSync(tempPath); } catch {} } };
  const fail = (status: number, error: string) => {
    if (responded) return;
    responded = true;
    cleanup();
    res.status(status).json({ error });
  };

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('file', (_name, stream, info) => {
    tempPath = path.join(path.resolve(config.uploadDir), `simple-${generateVideoId()}`);
    const ws = createWriteStream(tempPath);
    if (!fields.filename && info.filename) fields.filename = info.filename;
    filePromise = new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => { receivedSize += c.length; });
      stream.on('limit', () => { tooBig = true; });   // busboy truncates at fileSize
      stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      stream.pipe(ws);
    });
  });

  bb.on('error', (err: unknown) =>
    fail(400, `Upload parse error: ${err instanceof Error ? err.message : String(err)}`));

  bb.on('close', async () => {
    if (responded) return;
    try { await filePromise; } catch { return fail(400, 'File write failed'); }

    if (tooBig || receivedSize > config.maxUploadSize) {
      return fail(413, `Video exceeds the maximum allowed size of ` +
        `${Math.round(config.maxUploadSize / (1024 * 1024 * 1024))}GB`);
    }
    if (!tempPath || receivedSize === 0) return fail(400, 'No file part in request');

    // Build tusd-style headers so validateUploadAuth is reused UNCHANGED.
    const synthHeaders: Record<string, string[]> = {};
    if (req.headers['x-api-key']) synthHeaders['x-api-key'] = [String(req.headers['x-api-key'])];
    if (fields.token) synthHeaders['authorization'] = [`Bearer ${fields.token}`];
    if (req.headers.origin) synthHeaders['origin'] = [String(req.headers.origin)];

    const metadata: Record<string, string> = { filename: fields.filename || '' };
    // token claims override owner/short/permlink; these are only fallbacks.
    for (const k of ['owner', 'short', 'permlink', 'frontend_app', 'duration'] as const) {
      if (fields[k]) metadata[k] = fields[k];
    }

    const auth = await validateUploadAuth(synthHeaders, metadata, receivedSize, database, config, false);
    if (!auth.ok) return fail(auth.status, auth.error);

    const { owner, permlink, frontend_app, short, gated, allowlist, deferEncode, originalFilename, duration } = auth;

    await database.createVideoEntry({
      owner, permlink, frontend_app,
      status: 'uploading',
      input_cid: null, ipfs_pin_endpoint: null, manifest_cid: null, thumbnail_url: null,
      short, gated, gate_video_id: gated ? permlink : null, allowlist, defer_encode: deferEncode, duration, size: receivedSize,
      encodingProgress: 0,
      originalFilename,
      hive_author: null, hive_permlink: null, hive_title: null, hive_body: null, hive_tags: null,
      embed_url: null, embed_title: null,
      listed_on_3speak: frontend_app === '3speak-tv',
      processed: false, processedAt: null, views: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
    console.log(`Simple upload received: ${owner}/${permlink} [${frontend_app}] ` +
      `(${receivedSize} bytes) -> ${tempPath}`);

    // Same async pipeline as the TUS post-finish hook: pin -> announce -> job -> cleanup.
    const meta = { permlink, owner, short: String(short), originalFilename: originalFilename || '' };
    const finalPath = tempPath;
    setImmediate(() => {
      processUploadAsync(finalPath, meta, receivedSize, database, config)
        .catch((err: Error) => console.error('simple-upload async error:', err));
    });

    responded = true;
    res.status(201).json({ success: true, embed_url: embedUrl, permlink, owner });
  });

  req.on('aborted', () => fail(499, 'client aborted'));
  req.pipe(bb);
});

// ---- Chunked (resumable, parallel, no-PATCH) upload -------------------------
// Resumable fallback for clients where the TUS PATCH flow is blocked but the
// upload still needs to survive drops (unlike /upload/simple, which restarts
// from 0). Every request is a plain multipart POST — no PATCH, and with no
// custom request headers it stays CORS-preflight-free:
//   POST /upload/probe         {chunk}                     -> {ok, bytes}
//   POST /upload/chunk/create  {token, filename, duration, size, chunkSize, probed}
//        -> {sessionId, chunkSize, totalChunks, received:[], embed_url, permlink}
//   POST /upload/chunk         {sessionId, index, chunk}   -> {index, receivedBytes, size, complete}
//   POST /upload/chunk/status  {sessionId}                 -> {chunkSize, totalChunks, receivedBytes, size, received:[], finished}
//   POST /upload/chunk/finish  {sessionId}                 -> {success, embed_url, permlink}
//
// Chunks are INDEX-addressed, so they can arrive out of order and in PARALLEL:
// the server pre-sizes the temp file at create and does a positioned write for
// each chunk, tracking a received-index set. The single-use token is consumed
// once at create; later requests are authed by the server-minted sessionId.
// Resume: re-query /status, re-send the indices not in `received`. Sessions live
// in memory on this host (the fallback is pinned to one host) and survive network
// drops; they're reaped after CHUNK_SESSION_TTL_MS.
interface ChunkSession {
  owner: string;
  permlink: string;
  short: boolean;
  originalFilename: string | null;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  received: Set<number>;
  receivedBytes: number;
  tempPath: string;
  finished: boolean;
  updatedAt: number;
}
const chunkSessions = new Map<string, ChunkSession>();
const CHUNK_PART_MAX = 64 * 1024 * 1024;            // hard ceiling for one chunk request body
const CHUNK_MIN_SIZE = 256 * 1024;                  // smallest agreed chunkSize
// Ceiling for a client that did NOT measure its link (no `probed` field). Such a
// client sized its chunks from navigator.connection, which reports optimistically
// on mobile — a dying carrier link still answers "4g" — and chunkSize is frozen
// for the life of the session, so guessing high dead-ends the upload with no way
// back. One account spent a week stuck at 0% retrying 1MB chunks over a link that
// never delivered one. Clamping here is also the only fix that reaches clients
// running an older cached bundle, which a frontend change cannot.
const CHUNK_MAX_UNPROBED = 256 * 1024;
const CHUNK_PROBE_MAX = 512 * 1024;                 // hard bound on a /upload/probe body
const CHUNK_MAX_COUNT = 100_000;                    // sanity cap on totalChunks
const CHUNK_SESSION_TTL_MS = 2 * 60 * 60 * 1000;    // idle-session lifetime before reap

const chunkReaper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of chunkSessions) {
    if (now - s.updatedAt > CHUNK_SESSION_TTL_MS) {
      chunkSessions.delete(id);
      try { unlinkSync(s.tempPath); } catch { /* already gone */ }
      if (!s.finished) database.updateVideoStatus(s.permlink, 'failed', { encodingProgress: 0 }).catch(() => {});
      console.warn(`Chunked session reaped (idle): ${s.owner}/${s.permlink} at ${s.receivedBytes}/${s.totalSize}`);
    }
  }
}, 10 * 60 * 1000);
if (typeof chunkReaper.unref === 'function') chunkReaper.unref();

// Parse a small multipart request: all fields, plus (optionally) ONE file part
// buffered in memory (bounded by CHUNK_PART_MAX). Chunk bodies are small by design.
function parseChunkRequest(
  req: Request,
  withFile: boolean,
  maxFileSize: number = CHUNK_PART_MAX
): Promise<{ fields: Record<string, string>; fileBuf: Buffer | null }> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { files: withFile ? 1 : 0, fields: 15, fileSize: maxFileSize } });
    } catch {
      return reject(Object.assign(new Error('Expected multipart/form-data'), { status: 400 }));
    }
    const fields: Record<string, string> = {};
    const parts: Buffer[] = [];
    let tooBig = false;
    bb.on('field', (name: string, val: string) => { fields[name] = val; });
    bb.on('file', (_name: string, stream: NodeJS.ReadableStream) => {
      stream.on('data', (c: Buffer) => parts.push(c));
      stream.on('limit', () => { tooBig = true; });
      stream.on('error', (e: Error) => reject(Object.assign(e, { status: 400 })));
    });
    bb.on('error', (e: unknown) =>
      reject(Object.assign(new Error(e instanceof Error ? e.message : String(e)), { status: 400 })));
    bb.on('close', () => {
      if (tooBig) return reject(Object.assign(new Error(`Chunk exceeds ${maxFileSize} bytes`), { status: 413 }));
      resolve({ fields, fileBuf: parts.length ? Buffer.concat(parts) : null });
    });
    req.on('aborted', () => reject(Object.assign(new Error('client aborted'), { status: 499 })));
    req.pipe(bb);
  });
}

app.post('/upload/chunk/create', async (req: Request, res: Response) => {
  let fields: Record<string, string>;
  try { ({ fields } = await parseChunkRequest(req, false)); }
  catch (e) { return res.status((e as any)?.status || 400).json({ error: (e as any)?.message || 'Bad request' }); }

  const totalSize = parseInt(fields.size || '0', 10);
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return res.status(400).json({ error: 'size (total bytes) is required' });
  }
  if (totalSize > config.maxUploadSize) {
    return res.status(413).json({ error: `Video exceeds the maximum allowed size of ${Math.round(config.maxUploadSize / (1024 * 1024 * 1024))}GB` });
  }
  const requestedChunkSize = parseInt(fields.chunkSize || '0', 10);
  if (!Number.isFinite(requestedChunkSize) || requestedChunkSize < CHUNK_MIN_SIZE || requestedChunkSize > CHUNK_PART_MAX) {
    return res.status(400).json({ error: `chunkSize must be between ${CHUNK_MIN_SIZE} and ${CHUNK_PART_MAX} bytes` });
  }
  // A client that probed the link (POST /upload/probe) sends probed=1 and is
  // trusted with the size it measured; one that did not is guessing, and gets the
  // floor. The effective size goes back in the response and the client slices to
  // THAT, so a clamp here silently corrects a bad guess instead of failing it.
  const probed = fields.probed === '1';
  const chunkSize = probed ? requestedChunkSize : Math.min(requestedChunkSize, CHUNK_MAX_UNPROBED);
  const totalChunks = Math.ceil(totalSize / chunkSize);
  if (totalChunks > CHUNK_MAX_COUNT) {
    return res.status(400).json({ error: 'chunkSize too small for this file (too many chunks)' });
  }

  const synthHeaders: Record<string, string[]> = {};
  if (req.headers['x-api-key']) synthHeaders['x-api-key'] = [String(req.headers['x-api-key'])];
  if (fields.token) synthHeaders['authorization'] = [`Bearer ${fields.token}`];
  if (req.headers.origin) synthHeaders['origin'] = [String(req.headers.origin)];

  const metadata: Record<string, string> = { filename: fields.filename || '' };
  for (const k of ['owner', 'short', 'permlink', 'frontend_app', 'duration'] as const) {
    if (fields[k]) metadata[k] = fields[k];
  }

  const auth = await validateUploadAuth(synthHeaders, metadata, totalSize, database, config, false);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const { owner, permlink, frontend_app, short, gated, allowlist, deferEncode, originalFilename, duration } = auth;

  await database.createVideoEntry({
    owner, permlink, frontend_app,
    status: 'uploading',
    input_cid: null, ipfs_pin_endpoint: null, manifest_cid: null, thumbnail_url: null,
    short, gated, gate_video_id: gated ? permlink : null, allowlist, defer_encode: deferEncode, duration, size: totalSize,
    encodingProgress: 0,
    originalFilename,
    hive_author: null, hive_permlink: null, hive_title: null, hive_body: null, hive_tags: null,
    embed_url: null, embed_title: null,
    listed_on_3speak: frontend_app === '3speak-tv',
    processed: false, processedAt: null, views: 0,
    createdAt: new Date(), updatedAt: new Date(),
  });

  const tempPath = path.join(path.resolve(config.uploadDir), `chunked-${generateVideoId()}`);
  // Pre-size the file (sparse) so out-of-order positioned writes always land in range.
  try {
    const fd = await fsp.open(tempPath, 'w');
    try { await fd.truncate(totalSize); } finally { await fd.close(); }
  } catch (err) {
    console.error(`Failed to allocate chunked temp file for ${owner}/${permlink}:`, err);
    return res.status(500).json({ error: 'Failed to allocate upload storage' });
  }

  const sessionId = randomBytes(24).toString('hex');
  chunkSessions.set(sessionId, {
    owner, permlink, short, originalFilename,
    totalSize, chunkSize, totalChunks,
    received: new Set<number>(), receivedBytes: 0,
    tempPath, finished: false, updatedAt: Date.now(),
  });

  const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
  console.log(`Chunked upload session created: ${owner}/${permlink} [${frontend_app}] (${totalSize} bytes, ${totalChunks}x${chunkSize}${probed ? ', probed' : `, clamped from ${requestedChunkSize}`})`);
  res.status(201).json({ success: true, sessionId, chunkSize, totalChunks, received: [], permlink, owner, embed_url: embedUrl });
});

// Throughput probe. The client pushes a small blob, times it, and sizes its
// chunks from what the link actually did instead of from navigator.connection.
// The probe is the smallest body the client will ever send, so a probe that
// cannot get through is itself the answer: take the floor.
//
// Unauthenticated on purpose — it runs BEFORE the upload token is minted (create
// consumes it), it writes nothing, and the body is bounded by CHUNK_PROBE_MAX.
// The bytes are read only to drain the socket, then dropped.
app.post('/upload/probe', async (req: Request, res: Response) => {
  let fileBuf: Buffer | null;
  try { ({ fileBuf } = await parseChunkRequest(req, true, CHUNK_PROBE_MAX)); }
  catch (e) { return res.status((e as any)?.status || 400).json({ error: (e as any)?.message || 'Bad request' }); }
  res.json({ ok: true, bytes: fileBuf ? fileBuf.length : 0 });
});

app.post('/upload/chunk/status', async (req: Request, res: Response) => {
  let fields: Record<string, string>;
  try { ({ fields } = await parseChunkRequest(req, false)); }
  catch (e) { return res.status((e as any)?.status || 400).json({ error: (e as any)?.message || 'Bad request' }); }
  const s = chunkSessions.get(fields.sessionId || '');
  if (!s) return res.status(404).json({ error: 'Unknown or expired session' });
  res.json({
    chunkSize: s.chunkSize, totalChunks: s.totalChunks,
    receivedBytes: s.receivedBytes, size: s.totalSize,
    received: Array.from(s.received), finished: s.finished,
  });
});

app.post('/upload/chunk', async (req: Request, res: Response) => {
  let fields: Record<string, string>;
  let fileBuf: Buffer | null;
  try { ({ fields, fileBuf } = await parseChunkRequest(req, true)); }
  catch (e) { return res.status((e as any)?.status || 400).json({ error: (e as any)?.message || 'Bad request' }); }

  const s = chunkSessions.get(fields.sessionId || '');
  if (!s) return res.status(404).json({ error: 'Unknown or expired session' });
  if (s.finished) return res.status(409).json({ error: 'Session already finished' });
  if (!fileBuf || fileBuf.length === 0) return res.status(400).json({ error: 'No chunk data' });

  const index = parseInt(fields.index ?? '-1', 10);
  if (!Number.isInteger(index) || index < 0 || index >= s.totalChunks) {
    return res.status(400).json({ error: `index out of range (0..${s.totalChunks - 1})` });
  }
  // Last chunk is the remainder; every other chunk must be exactly chunkSize.
  const expectedLen = index === s.totalChunks - 1
    ? s.totalSize - s.chunkSize * (s.totalChunks - 1)
    : s.chunkSize;
  if (fileBuf.length !== expectedLen) {
    return res.status(400).json({ error: `chunk ${index} must be ${expectedLen} bytes, got ${fileBuf.length}` });
  }
  // Already have it (a retried chunk whose ack was lost) — idempotent success.
  if (s.received.has(index)) {
    return res.json({ index, receivedBytes: s.receivedBytes, size: s.totalSize, complete: s.received.size === s.totalChunks });
  }

  try {
    // Positioned write into the pre-sized file — disjoint regions, so concurrent
    // chunk writes never collide. Own fd per request to avoid shared-fd races.
    const fd = await fsp.open(s.tempPath, 'r+');
    try { await fd.write(fileBuf, 0, fileBuf.length, index * s.chunkSize); }
    finally { await fd.close(); }
    // Count once even under a same-index double-send: the add() from whichever
    // handler ran first makes has(index) true for the other before it counts.
    if (!s.received.has(index)) {
      s.received.add(index);
      s.receivedBytes += fileBuf.length;
    }
    s.updatedAt = Date.now();
    res.json({ index, receivedBytes: s.receivedBytes, size: s.totalSize, complete: s.received.size === s.totalChunks });
  } catch (err) {
    console.error(`Chunk ${index} write failed for ${s.owner}/${s.permlink}:`, err);
    res.status(500).json({ error: 'Chunk write failed' });
  }
});

app.post('/upload/chunk/finish', async (req: Request, res: Response) => {
  let fields: Record<string, string>;
  try { ({ fields } = await parseChunkRequest(req, false)); }
  catch (e) { return res.status((e as any)?.status || 400).json({ error: (e as any)?.message || 'Bad request' }); }

  const s = chunkSessions.get(fields.sessionId || '');
  if (!s) return res.status(404).json({ error: 'Unknown or expired session' });

  const embedUrl = `${config.baseUrl}?v=${s.owner}/${s.permlink}`;
  if (s.finished) return res.json({ success: true, embed_url: embedUrl, permlink: s.permlink, owner: s.owner });
  if (s.received.size !== s.totalChunks || s.receivedBytes !== s.totalSize) {
    return res.status(400).json({
      error: `Upload incomplete: ${s.received.size}/${s.totalChunks} chunks (${s.receivedBytes}/${s.totalSize} bytes)`,
      received: Array.from(s.received),
    });
  }

  s.finished = true;
  chunkSessions.delete(fields.sessionId || '');
  console.log(`Chunked upload finished: ${s.owner}/${s.permlink} (${s.totalSize} bytes) -> ${s.tempPath}`);

  // Same async pipeline as the TUS post-finish hook: pin -> announce -> job -> cleanup.
  const meta = { permlink: s.permlink, owner: s.owner, short: String(s.short), originalFilename: s.originalFilename || '' };
  const finalPath = s.tempPath;
  const size = s.totalSize;
  setImmediate(() => {
    processUploadAsync(finalPath, meta, size, database, config)
      .catch((err: Error) => console.error('chunked-upload async error:', err));
  });

  res.status(201).json({ success: true, embed_url: embedUrl, permlink: s.permlink, owner: s.owner });
});

// Live count of in-flight upload byte-requests (TUS create/chunk POST+PATCH),
// exposed via /health so the frontend can pick the least-busy server. Parallel
// chunks mean one upload can contribute several — that's fine as a relative load
// signal across homogeneous servers. (POST /uploads/token is handled above, so
// it never reaches here.)
let activeUploads = 0;
const countUpload = (req: Request, res: Response, next: () => void) => {
  if (req.method === 'POST' || req.method === 'PATCH') {
    activeUploads++;
    let done = false;
    const finish = () => { if (done) return; done = true; activeUploads = Math.max(0, activeUploads - 1); };
    res.once('finish', finish);
    res.once('close', finish);
  }
  next();
};
app.all('/uploads', countUpload, tusProxy);
app.all('/uploads/*', countUpload, tusProxy);

// Hook endpoint called by tusd for pre-create and post-finish events.
// Bound to 127.0.0.1 in tusd config — but guard here as defence-in-depth.
app.post('/tusd-hooks', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
  const remoteAddr = req.socket.remoteAddress;
  if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
    return res.status(403).json({});
  }

  const { Type, Event } = req.body;
  const { Upload, HTTPRequest } = Event || {};

  if (Type === 'pre-create') {
    const isPartial = !!Upload?.IsPartial;
    const authResult = await validateUploadAuth(
      HTTPRequest?.Header || {},
      Upload?.MetaData || {},
      Upload?.Size || null,
      database,
      config,
      isPartial
    );

    if (!authResult.ok) {
      return res.json({
        RejectUpload: true,
        HTTPResponse: {
          StatusCode: authResult.status,
          Body: JSON.stringify({ error: authResult.error }),
          Headers: { 'Content-Type': 'application/json' },
        },
      });
    }

    // Partial uploads are just chunk pieces — allow through without a DB record or embed URL.
    if (isPartial) {
      return res.json({});
    }

    const { owner, permlink, frontend_app, short, gated, allowlist, deferEncode, originalFilename, duration, size } = authResult;

    // Hard size cap, enforced for every upload regardless of auth method.
    // For parallel/Concatenation uploads this fires on the final concat, whose
    // Size is the sum of the already-uploaded parts.
    if (size != null && size > config.maxUploadSize) {
      console.warn(`Upload rejected: ${owner}/${permlink} size ${size} bytes exceeds cap ${config.maxUploadSize}`);
      return res.json({
        RejectUpload: true,
        HTTPResponse: {
          StatusCode: 413,
          Body: JSON.stringify({
            error: `Video exceeds the maximum allowed size of ${Math.round(config.maxUploadSize / (1024 * 1024 * 1024))}GB`,
          }),
          Headers: { 'Content-Type': 'application/json' },
        },
      });
    }

    console.log(`Upload metadata - short flag: "${Upload?.MetaData?.short}" -> parsed as: ${short}`);

    await database.createVideoEntry({
      owner,
      permlink,
      frontend_app,
      status: 'uploading',
      input_cid: null,
      ipfs_pin_endpoint: null,
      manifest_cid: null,
      thumbnail_url: null,
      short,
      // 🔐 Gated content. The gate knows this asset by its permlink.
      gated,
      gate_video_id: gated ? permlink : null,
      allowlist,
      defer_encode: deferEncode,
      duration,
      size,
      encodingProgress: 0,
      originalFilename,
      hive_author: null,
      hive_permlink: null,
      hive_title: null,
      hive_body: null,
      hive_tags: null,
      embed_url: null,
      embed_title: null,
      listed_on_3speak: frontend_app === '3speak-tv',
      processed: false,
      processedAt: null,
      views: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
    console.log(`Upload created: ${owner}/${permlink} [${frontend_app}] (${short ? 'short' : 'long'}, ${size} bytes)`);

    // Queue the embed URL so proxyRes can inject it into the 201 response.
    pending201EmbedUrls.push(embedUrl);
    setTimeout(() => {
      const idx = pending201EmbedUrls.indexOf(embedUrl);
      if (idx !== -1) pending201EmbedUrls.splice(idx, 1);
    }, 60_000);

    return res.json({
      ChangeFileInfo: {
        MetaData: {
          permlink,
          owner,
          frontend_app,
          short: String(short),
          originalFilename: originalFilename || '',
        },
      },
    });
  }

  if (Type === 'pre-finish') {
    // Store embed URL so proxyRes can inject it into the 204 response.
    if (!Upload?.IsPartial) {
      const { permlink, owner } = Upload?.MetaData || {};
      if (permlink && owner && Upload?.ID) {
        const embedUrl = `${config.baseUrl}?v=${owner}/${permlink}`;
        pending204EmbedUrls.set(Upload.ID, embedUrl);
        setTimeout(() => pending204EmbedUrls.delete(Upload.ID), 60_000);
      }
    }
    return res.json({});
  }

  if (Type === 'post-finish') {
    // Respond immediately — tusd already sent 204 to client. IPFS + job creation happen async.
    res.json({});

    if (!Upload?.IsPartial) {
      const filePath = Upload?.Storage?.Path;
      const meta = Upload?.MetaData || {};
      setImmediate(() => {
        processUploadAsync(filePath, meta, Upload?.Size || null, database, config)
          .catch((err: Error) => console.error('post-finish async error:', err));
      });
    }
    return;
  }

  return res.json({});
});

// Process completed upload: pin to IPFS, create encoding job, clean up temp file.
// Called asynchronously after tusd sends 204 to client — client does NOT wait for this.
/**
 * Queue an encode job.
 *
 * Shared by the eager upload path and the deferred POST /video/:permlink/encode
 * so the two cannot drift: `gated` and `gateVideoId` decide whether the job is
 * restricted to trusted encoders, and a job created without them is a job that
 * can be claimed by any community node.
 */
async function createEncodeJob(
  db: Database,
  fields: {
    owner: string;
    permlink: string;
    premium: boolean;
    short: boolean;
    fileSize: number | null;
    gated: boolean;
    gateVideoId: string;
  }
): Promise<void> {
  await db.createJob({
    owner: fields.owner,
    permlink: fields.permlink,
    status: 'pending',
    assignedWorker: null,
    encoderJobId: null,
    assignedAt: null,
    attemptCount: 0,
    lastError: null,
    encodingProgress: null,
    encodingStage: null,
    webhookReceivedAt: null,
    premium: fields.premium,
    short: fields.short,
    fileSize: fields.fileSize,
    gated: fields.gated,
    gateVideoId: fields.gateVideoId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Write gating onto the video and create its job, atomically-ordered (gating
 * first, so the dispatcher can never see a job for a video not yet marked
 * gated). Shared by the finalize route and the deferred-heal sweep so a
 * commissioned job always goes through the exact same sequence regardless of
 * which caller decided the video was ready.
 */
async function commissionEncode(
  db: Database,
  video: VideoMetadata,
  gated: boolean,
  allowlist: string[]
): Promise<void> {
  await db.updateVideoStatus(video.permlink, 'processing', {
    gated,
    gate_video_id: gated ? video.permlink : null,
    allowlist,
  });

  const premium = await db.isUserPremium(video.owner);
  await createEncodeJob(db, {
    owner: video.owner,
    permlink: video.permlink,
    premium,
    short: video.short === true,
    fileSize: video.size ?? null,
    gated,
    gateVideoId: video.permlink,
  });

  console.log(
    `${gated ? '🔐 Gated job' : 'Job'} commissioned for ${video.owner}/${video.permlink}` +
    `${gated ? ' — trusted encoders only' : ''}`
  );
}

async function processUploadAsync(
  filePath: string,
  meta: Record<string, string>,
  uploadSize: number | null,
  db: Database,
  cfg: typeof config
): Promise<void> {
  const permlink = meta.permlink;
  const owner = meta.owner;
  const short = meta.short === 'true';
  const originalFilename = meta.originalFilename || null;

  if (!permlink || !owner || !filePath) {
    console.error('post-finish: missing permlink, owner, or filePath', { permlink, owner, filePath });
    return;
  }

  try {
    console.log(`Pinning file to IPFS: ${filePath}`);
    const { cid: input_cid, endpoint: ipfs_pin_endpoint } = await pinFile(filePath);
    console.log(`File pinned successfully: ${input_cid} at ${ipfs_pin_endpoint}`);

    try {
      await announceDHT(input_cid);
    } catch (dhtError) {
      console.warn(`DHT announcement failed (non-critical): ${dhtError}`);
    }

    await db.updateVideoStatus(permlink, 'processing', {
      size: uploadSize,
      input_cid,
      ipfs_pin_endpoint,
      encodingProgress: 0,
    });

    try {
      await db.incrementUserUpload(owner, uploadSize || 0);
    } catch (statsError) {
      console.warn(`Failed to update user stats: ${statsError}`);
    }

    const premium = await db.isUserPremium(owner);

    // 🔐 Denormalise the gated flag onto the job so community claiming can
    // filter on it atomically. Read from the video document, which is the
    // source of truth: the TUS metadata is client-supplied and must never be
    // trusted to decide whether content is paid.
    const videoDoc = await db.getVideo(permlink);

    // Deferred: the bytes are in and pinned, but the encode is not commissioned
    // until POST /video/:permlink/encode says whether this video is gated.
    //
    // The decision cannot be made after encoding. It is the encoder that
    // encrypts, and an unencrypted rendition is public the instant its CID is
    // pinned — there is no taking it back. Eager job creation forced the choice
    // before the user could reach the toggle, which is exactly how a video
    // meant to be gated got published in the clear.
    if (videoDoc?.defer_encode === true) {
      await db.updateVideoStatus(permlink, 'awaiting_encode', { encodingProgress: 0 });
      console.log(
        `⏸️  Upload parked awaiting encode decision: ${owner}/${permlink} - Pinned: ${input_cid}`
      );
      try {
        unlinkSync(filePath);
        console.log(`Temp file cleaned up: ${filePath}`);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup temp file: ${cleanupError}`);
      }
      return;
    }

    const gated = videoDoc?.gated === true;
    if (gated) {
      console.log(`🔐 Gated job created for ${owner}/${permlink} — trusted encoders only`);
    }

    await createEncodeJob(db, {
      owner, permlink, premium, short, fileSize: uploadSize,
      gated, gateVideoId: videoDoc?.gate_video_id ?? permlink,
    });

    console.log(`Upload processed: ${owner}/${permlink} - Pinned: ${input_cid} - Job created`);

    try {
      unlinkSync(filePath);
      console.log(`Temp file cleaned up: ${filePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to cleanup temp file: ${cleanupError}`);
    }
  } catch (error) {
    console.error(`processUploadAsync error for ${owner}/${permlink}:`, error);
    await db.updateVideoStatus(permlink, 'failed', { encodingProgress: 0 });
  }
}

// Create uploads directory if it doesn't exist
const uploadPath = path.resolve(config.uploadDir);
// Demo page endpoint
app.get('/', (req: Request, res: Response) => {
  res.redirect('/demo.html');
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  // Load signals for the frontend's least-busy endpoint selection.
  let freeDiskPct: number | null = null;
  try {
    const st = statfsSync(config.uploadDir);
    const blocks = Number(st.blocks);
    if (blocks > 0) freeDiskPct = Math.round((Number(st.bavail) / blocks) * 100);
  } catch { /* statfs unsupported — leave null */ }
  res.json({
    status: 'ok',
    service: '3speak-video-upload',
    activeUploads,
    freeDiskPct,
  });
});

// Webhook endpoint for encoder callbacks
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    // Verify webhook API key — accept global key (managed) or per-job token (community)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey !== config.webhookApiKey) {
      // Check per-job callback token
      const { owner: o, permlink: p } = req.body;
      if (!o || !p || !apiKey) {
        console.warn('Webhook received with invalid API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const job = await database.getJob(o, p);
      if (!job || !job.callbackToken || job.callbackToken !== apiKey) {
        console.warn('Webhook received with invalid callback token');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const {
      owner,
      permlink,
      status,
      manifest_cid,
      video_url,
      job_id,
      processing_time_seconds,
      qualities_encoded,
      encoder_id,
      error: encoderError,
      timestamp,
    } = req.body;

    console.log(`Webhook received: ${owner}/${permlink} - Status: ${status}`);

    if (status === 'complete') {
      // Update video with manifest_cid and mark as published
      await database.updateVideoStatus(permlink, 'published', {
        manifest_cid,
        encodingProgress: 100,
      });

      // Update job as completed
      await database.updateJobStatus(owner, permlink, 'completed', {
        webhookReceivedAt: new Date(),
      });
      
      // Update user stats for successful encoding
      try {
        await database.incrementUserSuccess(owner);
      } catch (statsError) {
        console.warn(`Failed to update user success stats: ${statsError}`);
      }

      // 🔐 Register a gated video with the gate now that its manifest CID
      // exists. Until this succeeds the gate 404s the video and nobody can play
      // it, including the creator, so the failure is logged loudly and the
      // video is parked in a state an operator can find rather than being
      // published as if it worked.
      try {
        const gatedVideo = await database.getVideo(permlink);
        if (gatedVideo?.gated && manifest_cid) {
          if (!isGateConfigured(config)) {
            throw new Error('gate not configured on this instance');
          }
          // 🔐 Defense-in-depth: don't take the encoder's "complete" at face
          // value. A passthrough/remux fast path has been observed to skip
          // encryption entirely while still reporting success (see
          // internal-docs/gated-passthrough-bypass.md). Confirm the manifest
          // we're about to hand the gate is actually encrypted first.
          const verification = await verifyGatedManifestEncrypted(config, manifest_cid);
          if (!verification.encrypted) {
            throw new Error(`Gated output failed encryption verification: ${verification.reason}`);
          }
          await registerGatedVideo(config, {
            videoId: gatedVideo.gate_video_id || permlink,
            creator: owner,
            manifestCid: manifest_cid,
            allowlist: gatedVideo.allowlist,
          });
          console.log(`🔐 Gated video registered with gate: ${owner}/${permlink}`);
        }
      } catch (gateError) {
        console.error(
          `🚨 GATE REGISTRATION FAILED for gated video ${owner}/${permlink}:`,
          gateError instanceof Error ? gateError.message : gateError
        );
        await database.updateVideoStatus(permlink, 'failed', {
          encodingProgress: 100,
        }).catch(() => {});
      }

      // Unpin the input_cid now that encoding is complete
      try {
        const video = await database.getVideo(permlink);
        if (video && video.input_cid && video.ipfs_pin_endpoint) {
          console.log(`Unpinning input file for ${owner}/${permlink}: ${video.input_cid} from ${video.ipfs_pin_endpoint}`);
          await unpinFile(video.input_cid, video.ipfs_pin_endpoint);
        }
      } catch (unpinError) {
        console.warn(`Failed to unpin input_cid for ${owner}/${permlink}:`, unpinError);
        // Continue despite unpin failure
      }

      // If this upload exists only to replace another video's media, hand its
      // freshly-encoded manifest over to the original row now. Best-effort: the
      // encode itself succeeded, so a failure here must not fail the webhook.
      try {
        await applyPendingReplacement(permlink);
      } catch (replErr) {
        console.error(`Failed to apply pending replacement for ${permlink}:`, replErr);
      }

      console.log(`Video encoding completed: ${owner}/${permlink} - Manifest: ${manifest_cid}`);
      res.json({ success: true, message: 'Webhook processed successfully' });
    } else if (status === 'failed') {
      // Retry budget: requeue up to 2 times before giving up permanently.
      // attemptCount tracks all prior encode attempts (dispatch failures + webhook failures).
      const MAX_ENCODE_ATTEMPTS = 2;
      const job = await database.getJob(owner, permlink);

      if (job && job.attemptCount < MAX_ENCODE_ATTEMPTS) {
        // Still within retry budget — requeue for the dispatcher to pick up.
        const nextAttempt = job.attemptCount + 1;
        await database.updateJobStatus(owner, permlink, 'pending', {
          webhookReceivedAt: new Date(),
          lastError: `${encoderError || 'Encoding failed'} (attempt ${nextAttempt}/${MAX_ENCODE_ATTEMPTS + 1}, requeueing)`,
          assignedWorker: null,
          encoderJobId: null,
          assignedAt: null,
          encodingProgress: null,
          encodingStage: null,
        });
        await database.incrementJobAttempt(owner, permlink);
        await database.updateVideoStatus(permlink, 'processing', { encodingProgress: 0 });
        console.warn(`Encoding failed for ${owner}/${permlink} (attempt ${nextAttempt}/${MAX_ENCODE_ATTEMPTS + 1}): ${encoderError} — requeueing`);
        res.json({ success: true, message: 'Webhook processed (failure recorded, job requeued)' });
      } else {
        // Retry budget exhausted — permanent failure.
        await database.updateVideoStatus(permlink, 'failed', { encodingProgress: 0 });
        await database.updateJobStatus(owner, permlink, 'failed', {
          webhookReceivedAt: new Date(),
          lastError: encoderError || 'Encoding failed',
        });

        try {
          await database.incrementUserFailure(owner);
        } catch (statsError) {
          console.warn(`Failed to update user failure stats: ${statsError}`);
        }

        // DO NOT unpin on failure - keep the file for potential retry or debugging

        console.error(`Video encoding permanently failed for ${owner}/${permlink} after ${(job?.attemptCount ?? 0) + 1} attempt(s): ${encoderError}`);
        res.json({ success: true, message: 'Webhook processed (failure recorded)' });
      }
    } else {
      console.warn(`Unknown webhook status: ${status}`);
      res.status(400).json({ error: 'Unknown status' });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Webhook endpoint for encoder progress pings
app.post('/webhook/progress', async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const { owner, permlink, progress, stage } = req.body;

    if (!owner || !permlink || typeof progress !== 'number') {
      return res.status(400).json({ error: 'owner, permlink, and progress (number) are required' });
    }

    const job = await database.getJob(owner, permlink);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify auth — global key (managed) or per-job token (community)
    if (apiKey !== config.webhookApiKey) {
      if (!apiKey || !job.callbackToken || job.callbackToken !== apiKey) {
        console.warn('Progress webhook received with invalid API key');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    await database.updateJobStatus(owner, permlink, 'encoding', {
      encodingProgress: progress,
      encodingStage: stage ?? null,
    });

    await database.updateVideoStatus(permlink, 'processing', {
      encodingProgress: progress,
    });

    console.log(`Progress update: ${owner}/${permlink} - ${progress}%${stage ? ` (${stage})` : ''}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Progress webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Community encoder endpoints (JWS-authenticated)

// Registration
app.post('/api/v0/gateway/updateNode', async (req: Request, res: Response) => {
  try {
    const { payload, did } = await unwrapJWS(req.body.jws);

    // Accept both node_info wrapper and flat payload
    const nodeInfo = payload.node_info || payload;
    const name = nodeInfo.name;
    const hiveAccount = nodeInfo.cryptoAccounts?.hive || nodeInfo.hive_account;
    const peerId = nodeInfo.peer_id;
    const commitHash = nodeInfo.commit_hash;

    const encoder = await database.upsertCommunityEncoder(did, {
      name,
      hiveAccount,
      peerId,
      commitHash,
    });

    console.log(`Community encoder registered: ${encoder.name} (${did})${hiveAccount ? ` [hive: ${hiveAccount}]` : ''}`);
    res.json({
      success: true,
      encoder: {
        name: encoder.name,
        did: encoder.did,
        tier: encoder.tier,
        access: encoder.access,
        enabled: encoder.enabled,
      },
    });
  } catch (error) {
    console.error('Community registration error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Job polling
app.post('/api/v0/gateway/myJob', async (req: Request, res: Response) => {
  try {
    const { did } = await unwrapJWS(req.body.jws);

    const encoder = await database.getEncoderByDid(did);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not registered' });
    }
    if (!encoder.enabled || encoder.banned) {
      return res.status(403).json({ error: 'Encoder is disabled or banned' });
    }

    await database.updateEncoderLastSeen(did);

    const job = await database.claimNextCommunityJob(encoder.name, encoder.maxFileSize ?? null);
    if (!job) {
      return res.json({ success: true, job: null });
    }

    // Fetch video metadata for the job payload
    const video = await database.getVideo(job.permlink);
    if (!video || !video.input_cid) {
      // Job was claimed but video is missing — reset it
      await database.resetJob(job.owner, job.permlink);
      return res.json({ success: true, job: null });
    }

    // 🔐 Second gate on paid content, checked against the video rather than the
    // job. claimNextCommunityJob already filters on the denormalised flag; this
    // catches the case where that denormalisation was missed, because handing a
    // community operator the plaintext source of a paid video is not a failure
    // we can undo afterwards.
    if (video.gated) {
      await database.resetJob(job.owner, job.permlink);
      console.error(
        `🔐 BLOCKED: community encoder [${encoder.name}] claimed gated job ${job.owner}/${job.permlink}. ` +
        `Job reset to pending. The job record was missing gated:true — check job creation.`
      );
      return res.json({ success: true, job: null });
    }

    const ipfsGateway = 'https://ipfs.3speak.tv/ipfs';
    console.log(`Community encoder [${encoder.name}] claimed job: ${job.owner}/${job.permlink}`);
    res.json({
      success: true,
      job: {
        owner: job.owner,
        permlink: job.permlink,
        input_cid: `${ipfsGateway}/${video.input_cid}`,
        short: video.short,
        premium: false,
        webhook_url: config.webhookUrl,
        api_key: job.callbackToken,
        frontend_app: video.frontend_app,
        originalFilename: video.originalFilename,
      },
    });
  } catch (error) {
    console.error('Community job poll error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Heartbeat
app.post('/api/v0/gateway/heartbeat', async (req: Request, res: Response) => {
  try {
    const { did } = await unwrapJWS(req.body.jws);

    const encoder = await database.getEncoderByDid(did);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not registered' });
    }

    await database.updateEncoderLastSeen(did);
    res.json({ success: true });
  } catch (error) {
    console.error('Community heartbeat error:', error);
    if (error instanceof JWSAuthError) {
      return res.status(401).json({ error: 'Invalid JWS signature' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public encoder status for all encoders — for external monitoring systems
app.get('/api/v0/encoders/status', async (req: Request, res: Response) => {
  try {
    const allEncoders = await database.getAllEncoders();

    const encoders = allEncoders.map(e => ({
      name: e.name,
      access: e.access ?? 'managed',
      operator: e.hiveAccount ?? null,
      lastSeenAt: e.lastSeenAt ?? null,
    }));

    res.json({ success: true, encoders });
  } catch (error) {
    console.error('Encoder status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public community encoder status — for monitoring dashboards
app.get('/api/v0/encoders/community', async (req: Request, res: Response) => {
  try {
    const allEncoders = await database.getAllEncoders();
    const now = Date.now();
    const ALIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    const community = allEncoders
      .filter(e => (e.access ?? 'managed') === 'community')
      .map(e => ({
        name: e.name,
        enabled: e.enabled,
        banned: e.banned ?? false,
        lastSeenAt: e.lastSeenAt ?? null,
        alive: e.lastSeenAt ? (now - new Date(e.lastSeenAt).getTime()) < ALIVE_THRESHOLD_MS : false,
      }));

    res.json({ success: true, encoders: community });
  } catch (error) {
    console.error('Community encoder status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Commission the encode for a deferred upload, deciding gating at the same time.
 *
 * This is the second half of `defer_encode`: the bytes went up when the user
 * picked the file, and the gated choice arrives here, at publish. Doing it in
 * one call is deliberate — gating and job creation must be atomic, because a
 * job created first would be dispatched before the flag landed, and the encoder
 * would produce a plaintext rendition that no later update could recall.
 *
 * Authenticated with the finalize token minted alongside the upload token, not
 * the API key: granting gated status requires a verified owner, and the API key
 * ships inside browser bundles.
 */
app.post('/video/:permlink/encode', async (req: Request, res: Response) => {
  try {
    if (!config.uploadTokenSecret) {
      return res.status(503).json({ error: 'Upload tokens are not configured' });
    }

    const authHeader = req.get('authorization');
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!bearer) {
      return res.status(401).json({ error: 'Finalize token required' });
    }

    const claims = verifyUploadToken(bearer, config.uploadTokenSecret);
    if (!claims || claims.scope !== 'finalize') {
      return res.status(401).json({ error: 'Invalid or expired finalize token' });
    }

    const { permlink } = req.params;
    // The token is bound to one video. Without this, a finalize token would
    // commission an encode for somebody else's upload.
    if (claims.permlink !== permlink) {
      return res.status(403).json({ error: 'Finalize token is not valid for this video' });
    }

    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    if (video.owner !== claims.owner) {
      return res.status(403).json({ error: 'Finalize token is not valid for this video' });
    }

    // Idempotent: a retried publish must not queue the video twice.
    const existingJob = await database.getJob(video.owner, permlink);
    if (existingJob) {
      return res.status(200).json({
        success: true,
        already_queued: true,
        gated: video.gated === true,
      });
    }

    if (video.status !== 'awaiting_encode') {
      return res.status(409).json({
        error: `Video is not awaiting an encode decision (status: ${video.status})`,
        code: 'not_awaiting_encode',
      });
    }
    if (!video.input_cid) {
      return res.status(409).json({ error: 'Upload has no pinned input yet', code: 'not_pinned' });
    }

    const { gated = false, allowlist } = req.body || {};
    if (typeof gated !== 'boolean') {
      return res.status(422).json({ error: 'gated must be a boolean' });
    }

    let cleanAllowlist: string[] = [];
    if (gated) {
      if (!isGateConfigured(config)) {
        console.error('Gated encode requested but GATE_URL / GATE_INTERNAL_API_KEY are not set');
        return res.status(503).json({
          error: 'Gated uploads are not available on this instance',
          code: 'gate_not_configured',
        });
      }

      if (allowlist !== undefined) {
        if (!Array.isArray(allowlist) || allowlist.length > 500) {
          return res.status(422).json({ error: 'allowlist must be an array of at most 500 usernames' });
        }
        const bad = allowlist.find(
          (u: unknown) => typeof u !== 'string' || !/^[a-z][a-z0-9.-]{2,15}$/.test(String(u).trim().toLowerCase().replace(/^@/, ''))
        );
        if (bad !== undefined) {
          return res.status(422).json({ error: `"${bad}" is not a valid Hive account name` });
        }
        cleanAllowlist = [...new Set(allowlist.map((u: string) => String(u).trim().toLowerCase().replace(/^@/, '')))];
      }

      // Re-checked here rather than trusted from issuance: Pro can lapse
      // between picking a file and pressing publish, and this is the moment the
      // capability is actually granted.
      const isPro = await database.isUserPremium(video.owner);
      if (!isPro) {
        console.warn(`Gated encode refused for non-Pro user: ${video.owner}`);
        return res.status(403).json({ error: 'Gated uploads require 3Speak Pro', code: 'pro_required' });
      }
    }

    await commissionEncode(database, video, gated, cleanAllowlist);

    res.status(201).json({ success: true, gated, allowlist: cleanAllowlist });
  } catch (error) {
    console.error('Error commissioning encode:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get video metadata endpoint
app.get('/video/:permlink', async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const video = await database.getVideo(permlink);
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    res.json(video);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if a user has premium status (protected by API key)
app.get('/users/:username/premium', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const premium = user.premium ?? false;
    res.json({ username, premium });
  } catch (error) {
    console.error('Error checking premium status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update video thumbnail endpoint (protected)
app.post('/video/:permlink/thumbnail', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const { thumbnail_url } = req.body;
    
    if (!thumbnail_url) {
      return res.status(400).json({ error: 'thumbnail_url is required' });
    }
    
    // Check if video exists
    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Update thumbnail URL
    await database.updateVideoStatus(permlink, video.status, {
      thumbnail_url,
    });
    
    console.log(`Thumbnail updated for ${video.owner}/${permlink}`);
    res.json({ success: true, thumbnail_url });
  } catch (error) {
    console.error('Error updating thumbnail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Copy a finished replacement's media onto the video it was uploaded to replace.
 *
 * Runs when the NEW asset finishes encoding. The original row keeps everything
 * that identifies it (permlink, owner, createdAt, views, hive_* association) and
 * only its media pointer moves, so the video keeps its place in every feed and
 * the Hive post never has to change.
 *
 * The old manifest is preserved in `previousManifestCid` rather than discarded:
 * it makes the swap reversible and leaves the superseded media identifiable for
 * later unpinning. Safe to call twice — `replacementApplied` makes it a no-op.
 */
/**
 * Legacy statuses a media swap is allowed to bring back to `published`.
 *
 * A legacy row whose media is gone reads `deleted`, and the watch API answers it
 * with the shared "unavailable" placeholder — so leaving the status alone would
 * make the whole swap a no-op. Only the deletion-shaped states need this, and
 * only they get it: every OTHER status already serves whatever `video_v2` points
 * at (checked against published, publish_manual, scheduled, publish_later and
 * encoding_failed rows), so a swap there is visible without touching status —
 * and a scheduled or never-published video must not go out early as a side
 * effect of its owner replacing a file.
 *
 * NOTE: the legacy collection records no reason for a deletion, so a video the
 * creator removed and one moderation removed look identical here. The owner
 * check upstream means only the original poster can do this, and the media that
 * comes back is a NEW file, but if that trade is ever unwanted, emptying this
 * set disables reviving without touching anything else.
 */
const REVIVABLE_LEGACY_STATUSES = new Set(['deleted', 'self_deleted', 'delete']);

/** Legacy playback pointer for a manifest CID. Always this shape — 138k rows, no exceptions. */
const legacyVideoV2 = (cid: string) => `ipfs://${cid}/manifest.m3u8`;

/**
 * Apply a replacement whose ORIGINAL is a pre-embed (legacy) video.
 *
 * Same contract as the embed path — the original row keeps its permlink, owner,
 * created date, views, payout and beneficiaries, and only its media pointer
 * moves — but the pointer is legacy-shaped: playback resolves off `video_v2`
 * (`ipfs://<cid>/manifest.m3u8`), not `manifest_cid`, and a row left at status
 * `deleted` serves the placeholder no matter what its pointer says.
 *
 * The Hive post is not edited here either. Legacy posts carry no CID in their
 * json_metadata at all (`video.info.ipfs` is null on the ones that matter), so
 * the database really is the only place the media is addressed.
 */
async function applyLegacyReplacement(incoming: any): Promise<void> {
  const target = await database.getLegacyVideo(incoming.replacesPermlink);
  if (!target) {
    console.warn(`Replacement ${incoming.permlink}: legacy original ${incoming.replacesPermlink} is gone — skipping`);
    return;
  }

  const revive = REVIVABLE_LEGACY_STATUSES.has(target.status);
  await database.updateLegacyVideoMedia(target.permlink, {
    video_v2: legacyVideoV2(incoming.manifest_cid),
    ipfs: incoming.manifest_cid,
    ...(revive ? { status: 'published' } : {}),
    // Reversible and auditable: what it pointed at, and what state it was in.
    previousVideoV2: target.video_v2 ?? null,
    previousStatus: target.status,
    replacedByPermlink: incoming.permlink,
    mediaUpdatedAt: new Date(),
    // File-describing fields only. Title, tags, beneficiaries, views, created
    // belong to the original and are never touched.
    duration: incoming.duration ?? target.duration,
    size: incoming.size ?? target.size,
    originalFilename: incoming.originalFilename ?? target.originalFilename,
  });

  await database.updateVideoStatus(incoming.permlink, incoming.status, {
    replacementApplied: true,
    replaced: true,
    replacedAt: new Date(),
    replacedBy: target.permlink,
  } as any);

  console.log(
    `Legacy media replaced for ${target.owner}/${target.permlink}: ` +
    `${target.video_v2 || 'none'} -> ${legacyVideoV2(incoming.manifest_cid)} ` +
    `(via ${incoming.permlink}${revive ? `, status ${target.status} -> published` : ''})`
  );
}

async function applyPendingReplacement(newPermlink: string): Promise<void> {
  const incoming = await database.getVideo(newPermlink);
  if (!incoming?.replacesPermlink || incoming.replacementApplied) return;
  if (!incoming.manifest_cid) return; // not encoded yet — nothing to copy

  if (incoming.replacesLegacy) {
    await applyLegacyReplacement(incoming);
    return;
  }

  const target = await database.getVideo(incoming.replacesPermlink);
  if (!target) {
    console.warn(`Replacement ${newPermlink}: original ${incoming.replacesPermlink} is gone — skipping`);
    return;
  }

  await database.updateVideoStatus(target.permlink, 'published', {
    manifest_cid: incoming.manifest_cid,
    previousManifestCid: target.manifest_cid ?? null,
    mediaUpdatedAt: new Date(),
    encodingProgress: 100,
    // Carry across the properties that describe the FILE. Everything else —
    // title, tags, hive_*, createdAt, views — belongs to the original and must
    // not be touched.
    duration: incoming.duration ?? target.duration,
    size: incoming.size ?? target.size,
    originalFilename: incoming.originalFilename ?? target.originalFilename,
  } as any);

  await database.updateVideoStatus(newPermlink, incoming.status, {
    replacementApplied: true,
    replaced: true,
    replacedAt: new Date(),
    replacedBy: target.permlink,
  } as any);

  console.log(
    `Media replaced for ${target.owner}/${target.permlink}: ` +
    `${target.manifest_cid ?? 'none'} -> ${incoming.manifest_cid} (via ${newPermlink})`
  );
}

// Apply any replacement that finished encoding but never got swapped in.
//
// The completion webhook is delivered to WEBHOOK_URL (embed.3speak.tv), which is
// a SEPARATE deployment from whichever host accepted the upload — so the handler
// that applies the swap may never run on the host that registered it. This
// sweeper closes that gap: it works off the shared database, so it does not care
// which host published the asset, and it also recovers a webhook that was lost.
const REPLACEMENT_SWEEP_MS = 30_000;
setInterval(async () => {
  try {
    const pending = await database.getPendingReplacements();
    for (const v of pending) {
      try {
        await applyPendingReplacement(v.permlink);
      } catch (err) {
        console.error(`Replacement sweep: failed to apply ${v.permlink}:`, err);
      }
    }
  } catch (err) {
    // Never let a sweep failure take the process down.
    console.error('Replacement sweep failed:', err);
  }
}, REPLACEMENT_SWEEP_MS).unref?.();

// Abandon deferred uploads whose publish never came.
//
// A deferred upload holds a pinned input CID and no job, so nothing downstream
// will ever collect it: the dispatcher only looks at jobs. Left alone these
// accumulate pinned storage forever. Marking them failed also unpins the input,
// which matters most for the gated case — that input is the plaintext original.
const DEFERRED_SWEEP_MS = 15 * 60_000;
setInterval(async () => {
  try {
    const abandoned = await database.getAbandonedDeferred(DEFERRED_ENCODE_ABANDON_HOURS);
    for (const v of abandoned) {
      // Unpinning is best-effort cleanup, not a precondition for the status
      // transition below. An IPFS 500 ("not pinned or pinned indirectly") is
      // permanent, not transient — if it blocks the status write, the video
      // matches this same query again next cycle, fails the same unpin again,
      // and is orphaned in awaiting_encode forever: no job, no failed status,
      // invisible to the dispatcher and to any dashboard.
      if (v.input_cid && v.ipfs_pin_endpoint) {
        try {
          await unpinFile(v.input_cid, v.ipfs_pin_endpoint);
        } catch (unpinErr) {
          console.warn(`Deferred sweep: unpin failed for ${v.permlink} (continuing to mark failed):`, unpinErr);
        }
      }
      try {
        await database.updateVideoStatus(v.permlink, 'failed', { encodingProgress: 0 });
        console.log(`Deferred sweep: abandoned ${v.owner}/${v.permlink} (never published)`);
      } catch (err) {
        console.error(`Deferred sweep: failed to abandon ${v.permlink}:`, err);
      }
    }
  } catch (err) {
    console.error('Deferred sweep failed:', err);
  }
}, DEFERRED_SWEEP_MS).unref?.();

// Heal deferred uploads whose finalize call (POST /video/:permlink/encode)
// never arrived despite the owner having actually published — proof being a
// Hive post already linked via POST /video/:permlink/hive. This runs on a
// much shorter clock than the abandon sweep above: a dropped signal from a
// flaky frontend shouldn't strand a published video for 12 hours.
//
// Gating is never invented here — only ever carried forward from whatever the
// video already has on file. `video.gated` is set once, at upload-token
// issuance, and is only ever overwritten by a finalize call actually running
// (see commissionEncode). So before finalize runs it already holds the
// safest known value: usually false (most frontends don't ask about gating
// until after the upload starts), but a video that already declared
// gated:true up front is healed as gated, never silently downgraded to
// public. If Pro has lapsed in the meantime, healing is skipped rather than
// downgrading — the abandon sweep is the fallback for what this can't safely
// resolve on its own.
const DEFER_HEAL_GRACE_MINUTES = 20;
const DEFER_HEAL_SWEEP_MS = 5 * 60_000;
setInterval(async () => {
  try {
    const healable = await database.getHealableDeferred(DEFER_HEAL_GRACE_MINUTES);
    for (const v of healable) {
      try {
        if (!v.input_cid) continue; // not actually pinned yet; not our problem to fix

        // Idempotent against a late-arriving finalize call landing first.
        const existingJob = await database.getJob(v.owner, v.permlink);
        if (existingJob) continue;

        const gated = v.gated === true;
        if (gated) {
          const isPro = await database.isUserPremium(v.owner);
          if (!isPro) {
            console.warn(`Heal sweep: skipping gated video ${v.owner}/${v.permlink} — Pro has lapsed, will not silently downgrade`);
            continue;
          }
        }

        await commissionEncode(database, v, gated, Array.isArray(v.allowlist) ? v.allowlist : []);
        console.log(`Heal sweep: commissioned stalled encode for ${v.owner}/${v.permlink} (Hive post present, finalize signal never arrived)`);
      } catch (err) {
        console.error(`Heal sweep: failed to heal ${v.permlink}:`, err);
      }
    }
  } catch (err) {
    console.error('Heal sweep failed:', err);
  }
}, DEFER_HEAL_SWEEP_MS).unref?.();

// Register a freshly-uploaded asset as the replacement for an existing video.
//
// Called right after the new file is uploaded, with `:permlink` = the NEW asset
// and `replaces` = the ORIGINAL. Nothing swaps yet: the new asset still has to
// encode. When its webhook reports `complete`, the completion handler copies its
// manifest onto the original row (see applyPendingReplacement).
//
// Doing it this way — rather than repointing the Hive post at a new asset —
// keeps the original row's permlink, createdAt, views and Hive association, so
// the video holds its place in every feed and no on-chain edit is needed.
// Can this permlink's media be replaced, and by whom?
//
// Exists so the frontend can ask BEFORE it uploads. Registration used to be the
// first check, which meant a rejected replacement had already uploaded and
// encoded a whole file — and because registration is what delists the carrier,
// the failure left an orphan asset listed in the owner's profile with no Hive
// post behind it. Checking first costs one request and leaves nothing behind.
app.get('/video/:permlink/replace-target', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const embed = await database.getVideo(permlink);
    if (embed) {
      return res.json({ found: true, kind: 'embed', owner: embed.owner, status: embed.status });
    }
    const legacy = await database.getLegacyVideo(permlink);
    if (legacy) {
      // Every legacy row qualifies, whatever its status. The watch API serves
      // whatever `video_v2` holds and `deleted` is the only status that overrides
      // it with the placeholder — verified against published, publish_manual,
      // scheduled, publish_later and encoding_failed rows, all of which serve
      // their real media. So giving any of them a new manifest makes it play, and
      // the deleted ones are covered by the status revive.
      return res.json({ found: true, kind: 'legacy', owner: legacy.owner, status: legacy.status });
    }
    res.status(404).json({ found: false, error: 'No video with that permlink' });
  } catch (error) {
    console.error('Error resolving replace target:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/video/:permlink/replaces', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;          // the NEW asset
    const { replaces } = req.body ?? {};      // the ORIGINAL permlink

    if (!replaces || typeof replaces !== 'string') {
      return res.status(400).json({ error: 'replaces (original permlink) is required' });
    }
    if (replaces === permlink) {
      return res.status(400).json({ error: 'A video cannot replace itself' });
    }

    const [incoming, embedTarget] = await Promise.all([
      database.getVideo(permlink),
      database.getVideo(replaces),
    ]);
    if (!incoming) return res.status(404).json({ error: 'Replacement video not found' });

    // The original may be a pre-embed video: ~387k of them live in the legacy
    // `videos` collection and have no row here at all, so an embed-only lookup
    // 404s on the entire back catalogue — which is exactly the content whose
    // media is most likely dead and most worth replacing.
    const legacyTarget = embedTarget ? null : await database.getLegacyVideo(replaces);
    const target = embedTarget ?? legacyTarget;
    if (!target) return res.status(404).json({ error: 'Original video not found' });
    // Only the same account may swap its own media.
    if (incoming.owner !== target.owner) {
      return res.status(403).json({ error: 'Both videos must belong to the same owner' });
    }

    await database.updateVideoStatus(permlink, incoming.status, {
      replacesPermlink: replaces,
      replacesLegacy: !!legacyTarget,
      replacementApplied: false,
      // The replacement is a carrier for media, not a video in its own right —
      // keep it out of listings so it never shows up as a duplicate upload.
      listed_on_3speak: false,
    } as any);

    // Already encoded (e.g. a re-registration after the fact)? Swap immediately
    // rather than waiting for a webhook that has already been and gone.
    if (incoming.status === 'published' && incoming.manifest_cid) {
      await applyPendingReplacement(permlink);
      return res.json({ success: true, permlink, replaces, applied: true, legacy: !!legacyTarget });
    }

    console.log(
      `Replacement registered: ${permlink} will replace ` +
      `${legacyTarget ? 'legacy ' : ''}${target.owner}/${replaces} once encoded`
    );
    res.json({ success: true, permlink, replaces, applied: false, legacy: !!legacyTarget });
  } catch (error) {
    console.error('Error registering replacement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link embed video to a Hive post (protected)
app.post('/video/:permlink/hive', requireApiKey, async (req: Request, res: Response) => {
  try {
    const { permlink } = req.params;
    const { hive_author, hive_permlink, hive_title, hive_body, hive_tags } = req.body;

    if (!hive_author || !hive_permlink) {
      return res.status(400).json({ error: 'hive_author and hive_permlink are required' });
    }

    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // An asset belongs to exactly ONE Hive post, so only bind while the slot is
    // still empty. Pasting the same play.3speak.tv/embed URL into a SECOND post
    // (e.g. an Ecency wave re-sharing a video already published to a community)
    // used to repoint the asset at whichever post called last. That rebind is
    // destructive and, worse, partial: hive_permlink/embed_url/hive_tags are
    // overwritten while hive_title survives (waves carry an empty on-chain
    // title, so the `hive_title ?` guard below skips it) and `category` survives
    // because it is owned by the checker's embedCategorySync, which resolves it
    // from hive_permlink and then never revisits a doc that already has one.
    // The result was a doc pointing at a Town Square wave while still labelled
    // with the original community, so the watch page and the community feeds
    // disagreed about where the video lives.
    //
    // Re-linking to the SAME post still falls through, so client retries stay
    // idempotent. A conflicting claim is a no-op, not an error: this endpoint is
    // called after the post is already broadcast, so failing it would report a
    // problem for a post that actually succeeded.
    if (video.hive_permlink && video.hive_permlink !== hive_permlink) {
      console.warn(
        `Hive link SKIPPED for ${video.owner}/${permlink}: already linked to ` +
        `@${video.hive_author}/${video.hive_permlink}, refused rebind to ` +
        `@${hive_author}/${hive_permlink}`
      );
      return res.json({
        success: true,
        permlink,
        relinked: false,
        hive_author: video.hive_author,
        hive_permlink: video.hive_permlink,
      });
    }

    await database.updateVideoStatus(permlink, video.status, {
      hive_author,
      hive_permlink,
      embed_url: `@${hive_author}/${hive_permlink}`,
      processed: true,
      ...(hive_title ? { hive_title } : {}),
      ...(hive_body ? { hive_body } : {}),
      ...(hive_tags ? { hive_tags } : {}),
    });

    console.log(`Hive link set for ${video.owner}/${permlink} -> @${hive_author}/${hive_permlink}`);
    res.json({ success: true, permlink, hive_author, hive_permlink });
  } catch (error) {
    console.error('Error linking Hive post:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Force re-dispatch a stuck job (protected)
app.post('/admin/jobs/:owner/:permlink/redispatch', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { owner, permlink } = req.params;

    const job = await database.getJob(owner, permlink);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const video = await database.getVideo(permlink);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!video.input_cid) {
      return res.status(400).json({ error: 'Video has no input_cid — nothing to dispatch' });
    }

    await database.resetJob(owner, permlink);
    await database.updateVideoStatus(permlink, 'processing', { encodingProgress: 0 });

    console.log(`Job manually reset to pending by admin: ${owner}/${permlink} (was: ${job.status})`);
    res.json({
      success: true,
      message: 'Job reset to pending. Dispatcher will pick it up on the next cycle.',
      job: { owner, permlink, previousStatus: job.status },
    });
  } catch (error) {
    console.error('Error re-dispatching job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List jobs by status, enriched with video info (for the videofixer repair tool)
app.get('/admin/jobs', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'failed';
    const validStatuses = ['pending', 'encoding', 'completed', 'failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const jobs = await database.getJobsForVideofixer(status as JobStatus, limit);
    res.json({ jobs, count: jobs.length });
  } catch (error) {
    console.error('Error listing jobs for videofixer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Create API Key (protected)
app.post('/admin/api-keys', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { app_name, owner } = req.body;
    
    if (!app_name || !owner) {
      return res.status(400).json({ error: 'app_name and owner are required' });
    }
    
    // Generate secure API key
    const key = generateApiKey(app_name);
    
    const apiKey = {
      key,
      app_name,
      owner,
      active: true,
      createdAt: new Date(),
      lastUsed: null,
    };
    
    await database.createApiKey(apiKey);
    
    console.log(`API key created for ${app_name} (${owner})`);
    res.json({ success: true, key, app_name, owner });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all API Keys (protected)
app.get('/admin/api-keys', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const keys = await database.getAllApiKeys();
    res.json({ keys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update API Key Status (activate/deactivate) (protected)
app.patch('/admin/api-keys/:key', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { active } = req.body;
    
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    
    const apiKey = await database.getApiKey(key);
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }
    
    await database.updateApiKeyStatus(key, active);
    
    console.log(`API key ${key} ${active ? 'activated' : 'deactivated'}`);
    res.json({ success: true, key, active });
  } catch (error) {
    console.error('Error updating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all users (protected)
app.get('/admin/users', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;
    const search = req.query.search as string;
    const users = await database.getAllUsers(limit, skip, search);
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Ban/Unban user (protected)
app.patch('/admin/users/:username/ban', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const { banned } = req.body;
    
    if (typeof banned !== 'boolean') {
      return res.status(400).json({ error: 'banned must be a boolean' });
    }
    
    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await database.banUser(username, banned);
    
    console.log(`User ${username} ${banned ? 'banned' : 'unbanned'}`);
    res.json({ success: true, username, banned });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Set/remove premium status (protected)
app.patch('/admin/users/:username/premium', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const { premium } = req.body;

    if (typeof premium !== 'boolean') {
      return res.status(400).json({ error: 'premium must be a boolean' });
    }

    const user = await database.getUser(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await database.setUserPremium(username, premium);

    console.log(`User ${username} premium status set to ${premium}`);
    res.json({ success: true, username, premium });
  } catch (error) {
    console.error('Error setting premium status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Cleanup preview (protected)
app.get('/admin/cleanup/preview', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const preview = await cleanupService.previewCleanup();
    const totalMB = (preview.totalSize / (1024 * 1024)).toFixed(2);
    res.json({
      filesCount: preview.files.length,
      totalSizeMB: totalMB,
      retentionDays: config.cleanupRetentionDays,
      files: preview.files.map(f => ({
        name: f.name,
        sizeMB: (f.size / (1024 * 1024)).toFixed(2),
        ageDays: f.age.toFixed(1),
      })),
    });
  } catch (error) {
    console.error('Error previewing cleanup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Manual cleanup trigger (protected)
app.post('/admin/cleanup/run', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    console.log('Manual cleanup triggered by admin');
    const stats = await cleanupService.runCleanup();
    const mbFreed = (stats.bytesFreed / (1024 * 1024)).toFixed(2);
    res.json({
      success: true,
      filesScanned: stats.filesScanned,
      filesDeleted: stats.filesDeleted,
      bytesFreed: stats.bytesFreed,
      mbFreed,
      errors: stats.errors,
    });
  } catch (error) {
    console.error('Error running cleanup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all encoders (protected) - API keys are stripped for security
app.get('/admin/encoders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const encoders = await database.getAllEncoders();
    // Strip apiKey from response to prevent exposure
    const sanitized = encoders.map(({ apiKey, ...rest }) => rest);
    res.json({ encoders: sanitized });
  } catch (error) {
    console.error('Error fetching encoders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Add encoder (protected)
app.post('/admin/encoders', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name, url, apiKey, enabled = true, access = 'managed', tier = 'standard', maxFileSize, trusted = false } = req.body;

    if (!name || !url || !apiKey) {
      return res.status(400).json({ error: 'name, url, and apiKey are required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Validate access and tier values
    const validAccess = ['managed', 'community'];
    const validTiers = ['performance', 'standard', 'lite'];
    if (!validAccess.includes(access)) {
      return res.status(400).json({ error: `access must be one of: ${validAccess.join(', ')}` });
    }
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (maxFileSize !== undefined && maxFileSize !== null &&
        (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0)) {
      return res.status(400).json({ error: 'maxFileSize must be a positive number or null' });
    }
    // 🔐 Defaults to false. Only an encoder we operate may receive gated jobs,
    // because the encoder holds the plaintext source of whatever it transcodes.
    if (typeof trusted !== 'boolean') {
      return res.status(400).json({ error: 'trusted must be a boolean' });
    }
    if (trusted && access === 'community') {
      return res.status(400).json({
        error: 'A community encoder cannot be trusted for gated content. Gated jobs expose the plaintext source.',
      });
    }

    const existing = await database.getEncoder(name);
    if (existing) {
      return res.status(409).json({ error: `Encoder '${name}' already exists` });
    }

    await database.createEncoder({
      name,
      url,
      apiKey,
      enabled,
      access,
      tier,
      trusted,
      ...(maxFileSize !== undefined && { maxFileSize }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`Encoder added: ${name} (${url}) [${access}/${tier}${trusted ? '/trusted' : ''}]`);
    res.json({ success: true, name, url, enabled, access, tier, trusted });
  } catch (error) {
    console.error('Error adding encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update encoder (enable/disable, change url or apiKey) (protected)
app.patch('/admin/encoders/:name', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { url, apiKey, enabled, access, tier, maxFileSize, banned, trusted } = req.body;

    const encoder = await database.getEncoder(name);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not found' });
    }

    const updates: Record<string, any> = {};
    if (url !== undefined) {
      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
      updates.url = url;
    }
    if (apiKey !== undefined) updates.apiKey = apiKey;
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      updates.enabled = enabled;
    }
    if (access !== undefined) {
      const validAccess = ['managed', 'community'];
      if (!validAccess.includes(access)) {
        return res.status(400).json({ error: `access must be one of: ${validAccess.join(', ')}` });
      }
      updates.access = access;
    }
    if (tier !== undefined) {
      const validTiers = ['performance', 'standard', 'lite'];
      if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
      }
      updates.tier = tier;
    }
    // 🔐 Trust for gated (paid) content. Only ever set this on an encoder you
    // operate: it will receive the plaintext source of paid videos.
    if (trusted !== undefined) {
      if (typeof trusted !== 'boolean') {
        return res.status(400).json({ error: 'trusted must be a boolean' });
      }
      // A community node self-registers through the JWS gateway and is never
      // operated by us, so it must not be trustable even by an admin mistake.
      const effectiveAccess = access ?? encoder.access ?? 'managed';
      if (trusted && effectiveAccess === 'community') {
        return res.status(400).json({
          error: 'A community encoder cannot be trusted for gated content. Gated jobs expose the plaintext source.',
        });
      }
      updates.trusted = trusted;
      console.log(`🔐 Encoder [${name}] trusted flag set to ${trusted}`);
    }
    if (maxFileSize !== undefined) {
      if (maxFileSize !== null &&
          (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0)) {
        return res.status(400).json({ error: 'maxFileSize must be a positive number or null' });
      }
      updates.maxFileSize = maxFileSize;
    }

    if (banned !== undefined) {
      if (typeof banned !== 'boolean') {
        return res.status(400).json({ error: 'banned must be a boolean' });
      }
      updates.banned = banned;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await database.updateEncoder(name, updates);

    console.log(`Encoder updated: ${name}`);
    res.json({ success: true, name, updates });
  } catch (error) {
    console.error('Error updating encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Remove encoder (protected)
app.delete('/admin/encoders/:name', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    const encoder = await database.getEncoder(name);
    if (!encoder) {
      return res.status(404).json({ error: 'Encoder not found' });
    }

    await database.deleteEncoder(name);

    console.log(`Encoder removed: ${name}`);
    res.json({ success: true, name });
  } catch (error) {
    console.error('Error removing encoder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Encoder stats (aggregated from embed-jobs) (protected)
app.get('/admin/encoder-stats', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || '24h';
    const periodMs: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };

    if (!periodMs[period]) {
      return res.status(400).json({ error: 'period must be one of: 24h, 7d, 30d' });
    }

    const since = new Date(Date.now() - periodMs[period]);
    const jobs = await database.getCompletedJobStats(since);
    const encoders = await database.getAllEncoders();

    // Build encoder lookup for tier/access metadata
    const encoderMap = new Map<string, Encoder>();
    for (const enc of encoders) {
      encoderMap.set(enc.name, enc);
    }

    // Group jobs by assignedWorker
    const grouped = new Map<string, typeof jobs>();
    for (const job of jobs) {
      const worker = job.assignedWorker ?? 'unknown';
      if (!grouped.has(worker)) grouped.set(worker, []);
      grouped.get(worker)!.push(job);
    }

    // Compute per-encoder metrics
    const encoderStats = Array.from(grouped.entries()).map(([encoderName, encoderJobs]) => {
      const encoder = encoderMap.get(encoderName);
      const completed = encoderJobs.filter(j => j.status === 'completed');
      const failed = encoderJobs.filter(j => j.status === 'failed');

      // Compute avg encode time from completed jobs with valid timestamps
      const encodeTimes = completed
        .filter(j => j.assignedAt && j.webhookReceivedAt)
        .map(j => new Date(j.webhookReceivedAt!).getTime() - new Date(j.assignedAt!).getTime());
      const avgEncodeTimeMs = encodeTimes.length > 0
        ? Math.round(encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length)
        : 0;

      return {
        encoderName,
        tier: encoder?.tier ?? 'standard',
        access: encoder?.access ?? 'managed',
        totalJobs: encoderJobs.length,
        completedJobs: completed.length,
        failedJobs: failed.length,
        successRate: encoderJobs.length > 0
          ? Math.round((completed.length / encoderJobs.length) * 1000) / 10
          : 0,
        avgEncodeTimeMs,
      };
    });

    // Compute aggregate metrics
    const totalJobs = jobs.length;
    const totalCompleted = jobs.filter(j => j.status === 'completed').length;
    const totalFailed = jobs.filter(j => j.status === 'failed').length;
    const allEncodeTimes = jobs
      .filter(j => j.status === 'completed' && j.assignedAt && j.webhookReceivedAt)
      .map(j => new Date(j.webhookReceivedAt!).getTime() - new Date(j.assignedAt!).getTime());
    const periodHours = periodMs[period] / (60 * 60 * 1000);

    res.json({
      period,
      since: since.toISOString(),
      aggregate: {
        totalJobs,
        completedJobs: totalCompleted,
        failedJobs: totalFailed,
        successRate: totalJobs > 0
          ? Math.round((totalCompleted / totalJobs) * 1000) / 10
          : 0,
        avgEncodeTimeMs: allEncodeTimes.length > 0
          ? Math.round(allEncodeTimes.reduce((a, b) => a + b, 0) / allEncodeTimes.length)
          : 0,
        jobsPerHour: periodHours > 0
          ? Math.round((totalJobs / periodHours) * 10) / 10
          : 0,
      },
      encoders: encoderStats,
    });
  } catch (error) {
    console.error('Error fetching encoder stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
let dispatcher: JobDispatcher;
let tusdProcess: ReturnType<typeof startTusd> | null = null;

async function start() {
  try {
    await database.connect(config.mongoDbName, config.mongoCollectionVideos);

    // Initialize upload token collection (TTL indexes for auto-cleanup)
    if (config.uploadTokenSecret) {
      await database.initUploadTokenCollection();
    } else {
      console.log('Upload token auth disabled (UPLOAD_TOKEN_SECRET not set)');
    }

    // Ensure demo API key exists
    const demoKey = await database.getApiKey(config.demoApiKey);
    if (!demoKey) {
      await database.createApiKey({
        key: config.demoApiKey,
        app_name: 'demo',
        owner: 'system',
        active: true,
        createdAt: new Date(),
        lastUsed: null,
      });
      console.log('Demo API key created');
    }
    
    // Seed encoders from env var that don't already exist in DB (backwards-compatible)
    const existingEncoders = await database.getAllEncoders();
    const existingNames = new Set(existingEncoders.map(e => e.name));
    const encodersToSeed = config.encoders.filter(e => !existingNames.has(e.name));
    
    if (encodersToSeed.length > 0) {
      console.log(`Seeding ${encodersToSeed.length} new encoder(s) from env into DB...`);
      for (const e of encodersToSeed) {
        try {
          await database.createEncoder({
            name: e.name,
            url: e.url,
            apiKey: e.apiKey,
            enabled: e.enabled,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          console.log(`  Seeded encoder: ${e.name}`);
        } catch (seedErr: any) {
          // The embed-encoders `name` index is case-insensitive (collation), so an
          // encoder can already exist under a different-cased name. Don't let a
          // duplicate abort startup — it just means it's already registered.
          if (seedErr?.code === 11000) {
            console.warn(`  Encoder "${e.name}" already exists — skipping`);
          } else {
            throw seedErr;
          }
        }
      }
    }

    // Log current encoder pool
    const activeEncoders = (await database.getAllEncoders()).filter(e => e.enabled);
    if (activeEncoders.length > 0) {
      console.log(`Encoders available (${activeEncoders.length}):`);
      activeEncoders.forEach(e => console.log(`  - ${e.name}: ${e.url}`));
    } else {
      console.warn('⚠️  No enabled encoders in DB! Jobs will fail to dispatch.');
    }
    
    // Start job dispatcher (skip on secondary deployments — the dispatch path
    // isn't atomic across replicas, so two pollers can double-dispatch the same job).
    if (config.dispatcherEnabled) {
      dispatcher = new JobDispatcher(database, config);
      dispatcher.start(30); // Poll every 30 seconds
    } else {
      console.log('Job dispatcher disabled (DISPATCHER_ENABLED=false)');
    }

    // Start cleanup service
    if (config.cleanupEnabled) {
      cleanupService.start(config.cleanupIntervalHours);
    } else {
      console.log('Cleanup service disabled');
    }

    const server = app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`TUS endpoint: http://localhost:${config.port}/uploads`);
      // Start tusd after Express is listening so the hook endpoint is ready
      tusdProcess = startTusd(config, config.port);
    });

    server.requestTimeout = 30 * 60 * 1000;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (tusdProcess) tusdProcess.kill('SIGTERM');
  if (dispatcher) dispatcher.stop();
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (tusdProcess) tusdProcess.kill('SIGTERM');
  if (dispatcher) {
    dispatcher.stop();
  }
  cleanupService.stop();
  await database.close();
  process.exit(0);
});

start();
