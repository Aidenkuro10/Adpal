'use strict';

/**
 * Static delivery for the two presentation surfaces (/demo/ and /terminal/).
 *
 * The demo is edited live while the browser is open, so a stylesheet that the
 * browser keeps from a previous run is a real failure mode: the page renders
 * with the previous layout until a hard refresh. `express.static` alone is not
 * enough here — it answers `public, max-age=0` with an ETag, which still lets a
 * validator pair a 304 with a copy the tab already holds, and nothing in the
 * HTML changes when `style.css` does.
 *
 * This module replaces it with three guarantees:
 *
 *  1. **Dev responses are never stored.** `no-store` + no ETag/Last-Modified,
 *     so a normal refresh always gets the bytes currently on disk.
 *  2. **Asset URLs are content-addressed.** Every local `<link href>` and
 *     `<script src>` in an HTML view becomes `styles.css?v=<content hash>`.
 *     When the file changes the URL changes, so even a stubborn cache (disk
 *     cache, bfcache, a proxy) cannot serve the previous stylesheet.
 *  3. **CSS stays synchronous.** The rewrite only touches the `href` of an
 *     existing `<link>` in the document head; it never defers, preloads or
 *     injects anything from JavaScript, so there is no flash of unstyled
 *     content.
 *
 * In production the same URLs are served with `must-revalidate` and validators
 * enabled, so caching works normally without ever pinning a stale asset.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
});

/* Only local stylesheets and scripts are versioned. */
const ASSET_REF = /(\b(?:href|src)\s*=\s*["'])([^"'?#\s]+\.(?:css|js|mjs))(["'])/gi;

/* Content hash cache: re-hashed only when size or mtime moves. */
const versionCache = new Map();

/**
 * Cache headers for a static view response.
 *
 * @param {import('express').Response} res
 * @param {boolean} production
 * @param {boolean} addressed  the URL already carries a content hash
 */
function applyCacheHeaders(res, production, addressed) {
  if (!production) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return;
  }

  res.setHeader(
    'Cache-Control',
    addressed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate'
  );
}

/** Short content hash for one file, or null when it cannot be read. */
function assetVersion(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = versionCache.get(absPath);
  if (cached && cached.key === key) return cached.hash;

  let hash;
  try {
    hash = crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex').slice(0, 10);
  } catch {
    return null;
  }

  versionCache.set(absPath, { key, hash });
  return hash;
}

/**
 * Rewrites `style.css` to `style.css?v=<hash>` inside an HTML view.
 * External URLs, absolute protocol URLs and non-asset refs are left untouched.
 */
function versionAssets(html, htmlPath, root) {
  const dir = path.dirname(htmlPath);

  return html.replace(ASSET_REF, (match, open, ref, close) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return match;

    const abs = path.resolve(dir, ref);
    // Only files inside the served view directory can be addressed.
    if (abs !== root && !abs.startsWith(root + path.sep)) return match;

    const version = assetVersion(abs);
    return version ? `${open}${ref}?v=${version}${close}` : match;
  });
}

/**
 * Resolves a URL path to a file, mirroring the pieces of `express.static` this
 * project actually uses: directory index and extensionless `.html` fallback.
 *
 * @returns {{ file: string, index: boolean } | null}
 */
function resolveTarget(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const base = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (base !== root && !base.startsWith(root + path.sep)) return null;

  const candidates = [
    { file: base, index: false },
    { file: `${base}.html`, index: false },
    { file: path.join(base, 'index.html'), index: true }
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate.file).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/**
 * Express middleware serving one view directory.
 *
 * @param {string} rootDir  absolute directory to serve
 * @param {{ production?: boolean }} [options]
 */
function serveView(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const production = options.production === true;

  return function viewAsset(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const target = resolveTarget(root, req.path);
    if (!target) return next();

    // `/demo` must become `/demo/`, otherwise every relative asset in the page
    // resolves one level too high and the browser requests the wrong files.
    // The check is made on the original URL, not `req.path`: inside a mounted
    // handler `/demo` already looks like `/`.
    const requestedPath = req.originalUrl.split('?')[0];
    if (target.index && !requestedPath.endsWith('/')) {
      const [, search] = req.originalUrl.split('?');
      return res.redirect(production ? 301 : 302, `${requestedPath}/${search ? `?${search}` : ''}`);
    }

    const ext = path.extname(target.file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const addressed = typeof req.query.v === 'string' && req.query.v.length > 0;

    // Declared types above are authoritative: never let the browser sniff one.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (ext === '.html') {
      let raw;
      try {
        raw = fs.readFileSync(target.file, 'utf8');
      } catch (error) {
        return next(error);
      }

      const html = versionAssets(raw, target.file, root);
      applyCacheHeaders(res, production, false);
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', Buffer.byteLength(html));
      // A view is a document, not an asset: keep it revalidated in production.
      if (req.method === 'HEAD') return res.end();
      return res.end(html);
    }

    applyCacheHeaders(res, production, addressed && production);
    res.setHeader('Content-Type', type);

    return res.sendFile(
      target.file,
      {
        dotfiles: 'deny',
        // We own Cache-Control above, so `send` must not write one of its own.
        cacheControl: false,
        etag: production,
        lastModified: production
      },
      (error) => {
        if (error) next(error);
      }
    );
  };
}

module.exports = { serveView, versionAssets, assetVersion, MIME };
