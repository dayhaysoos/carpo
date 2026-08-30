import {
  CLIP_EXPORT_PRESETS,
  ClipDistribution,
  ClipDistributionError,
  SHARE_EXPIRATION_PRESETS,
  type ClipExportPreset,
  type ShareExpirationPreset,
} from "./clip-distribution";
import { dispatchGifExportJob } from "./jobs";
import type { Env } from "./env";
import type { AuthenticatedUser } from "./identity";
import { R2MediaDelivery } from "./r2-media-delivery";

const PUBLIC_SHARE_PREFIX = "/share";
const TOKEN_PATTERN = "[A-Za-z0-9_-]{43}";
const PUBLIC_SHARE_ROUTE = new RegExp(
  `^${PUBLIC_SHARE_PREFIX}/(${TOKEN_PATTERN})(?:/(media|download))?/?$`,
);

export async function handlePublicClipDistribution(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== PUBLIC_SHARE_PREFIX &&
    !url.pathname.startsWith(`${PUBLIC_SHARE_PREFIX}/`)
  ) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return publicResponse("Method not allowed", 405, {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
  }

  const match = url.pathname.match(PUBLIC_SHARE_ROUTE);
  if (!match) return unavailableSharePage("not_found");
  const [, token, action] = match;
  const distribution = createDistribution(env);
  let share;
  try {
    share = await distribution.resolve({ token });
  } catch (error) {
    if (error instanceof ClipDistributionError) {
      return unavailableSharePage(error.kind);
    }
    console.error(
      JSON.stringify({
        message: "public clip share resolution failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return unavailableSharePage("internal");
  }

  if (action === "media" || action === "download") {
    return serveSharedArtifact(request, env, share.artifactKey, {
      download: action === "download",
      title: share.title,
    });
  }
  if (request.method === "HEAD") {
    return publicResponse(null, 200, { "Content-Type": "text/html; charset=utf-8" });
  }
  return publicResponse(renderSharedClipPage(token, share), 200, {
    "Content-Type": "text/html; charset=utf-8",
  });
}

export async function handleClipDistributionApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: AuthenticatedUser,
): Promise<Response | null> {
  const url = new URL(request.url);
  const viewMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/distribution$/,
  );
  const createShareMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/distribution\/shares$/,
  );
  const revokeShareMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/distribution\/shares\/([^/]+)$/,
  );
  const exportMatch = url.pathname.match(
    /^\/api\/clips\/([^/]+)\/distribution\/exports\/([^/]+)$/,
  );
  if (!viewMatch && !createShareMatch && !revokeShareMatch && !exportMatch) {
    return null;
  }

  const distribution = createDistribution(env, (clipId) => {
    ctx.waitUntil(dispatchGifExportJob(env, clipId));
  });
  try {
    if (request.method === "GET" && viewMatch) {
      return apiJson(
        await distribution.view({
          ownerId: user.id,
          clipId: decodedSegment(viewMatch[1]),
        }),
      );
    }
    if (request.method === "POST" && createShareMatch) {
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const expiration = body.expiration;
      if (
        typeof expiration !== "string" ||
        !SHARE_EXPIRATION_PRESETS.includes(
          expiration as ShareExpirationPreset,
        )
      ) {
        return apiJson({ error: "Invalid share expiration" }, 400);
      }
      return apiJson(
        await distribution.perform({
          type: "create-share",
          ownerId: user.id,
          clipId: decodedSegment(createShareMatch[1]),
          expiration: expiration as ShareExpirationPreset,
          origin: url.origin,
        }),
        201,
      );
    }
    if (request.method === "DELETE" && revokeShareMatch) {
      return apiJson(
        await distribution.perform({
          type: "revoke-share",
          ownerId: user.id,
          clipId: decodedSegment(revokeShareMatch[1]),
          shareId: decodedSegment(revokeShareMatch[2]),
        }),
      );
    }
    if (request.method === "POST" && exportMatch) {
      const preset = decodedSegment(exportMatch[2]);
      if (!CLIP_EXPORT_PRESETS.includes(preset as ClipExportPreset)) {
        return apiJson({ error: "Invalid export preset" }, 400);
      }
      const result = await distribution.perform({
        type: "create-export",
        ownerId: user.id,
        clipId: decodedSegment(exportMatch[1]),
        preset: preset as ClipExportPreset,
      });
      return apiJson(result, result.type === "export" && result.started ? 202 : 200);
    }
    return apiJson({ error: "Method not allowed" }, 405, {
      Allow: allowedMethods({
        view: Boolean(viewMatch),
        createShare: Boolean(createShareMatch),
        revokeShare: Boolean(revokeShareMatch),
        export: Boolean(exportMatch),
      }),
    });
  } catch (error) {
    if (error instanceof ClipDistributionError) {
      return apiJson(
        { error: error.message },
        distributionErrorStatus(error),
      );
    }
    if (error instanceof URIError) {
      return apiJson({ error: "Invalid path" }, 400);
    }
    console.error(
      JSON.stringify({
        message: "clip distribution request failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return apiJson({ error: "Distribution operation failed" }, 500);
  }
}

function createDistribution(
  env: Env,
  scheduleGifExport?: (clipId: string) => void,
): ClipDistribution {
  return new ClipDistribution({
    db: env.DB,
    artifactPrefix: env.R2_PUBLIC_PREFIX,
    scheduleGifExport,
  });
}

async function serveSharedArtifact(
  request: Request,
  env: Env,
  key: string,
  options: { download: boolean; title: string },
): Promise<Response> {
  try {
    const outcome = await new R2MediaDelivery(env.CLIPS_BUCKET).deliver({
      key,
      method: request.method === "HEAD" ? "HEAD" : "GET",
      range: request.headers.get("Range"),
    });
    if (outcome.type === "missing") {
      return unavailableSharePage("unavailable");
    }
    if (outcome.type === "range-not-satisfiable") {
      outcome.headers.set("Content-Type", "text/plain; charset=utf-8");
      return publicResponse(
        "Requested range is unavailable",
        416,
        outcome.headers,
      );
    }

    decorateSharedArtifact(outcome.response, options);
    return outcome.response;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "shared clip artifact read failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return unavailableSharePage("unavailable");
  }
}

function decorateSharedArtifact(
  response: Response,
  options: { download: boolean; title: string },
): void {
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (options.download) {
    response.headers.set(
      "Content-Disposition",
      `attachment; filename="${safeFilename(options.title)}.mp4"`,
    );
  }
}

function renderSharedClipPage(
  token: string,
  share: {
    title: string;
    expiresAt: string | null;
  },
): string {
  const title = escapeHtml(share.title);
  const encodedToken = encodeURIComponent(token);
  const expiration = share.expiresAt
    ? `<p class="note">This link expires ${escapeHtml(
        new Date(share.expiresAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }),
      )} UTC.</p>`
    : '<p class="note">This link does not expire, but its owner can revoke it at any time.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Carpo</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080b12; color: #f4f6fb; }
    main { width: min(860px, calc(100% - 2rem)); margin: 2rem auto; }
    .brand { color: #9bb7ff; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; font-size: .78rem; }
    h1 { margin: .55rem 0 1.25rem; font-size: clamp(1.65rem, 5vw, 2.7rem); line-height: 1.08; overflow-wrap: anywhere; }
    video { display: block; width: 100%; max-height: 72vh; border-radius: 16px; background: #000; box-shadow: 0 24px 80px rgba(0,0,0,.4); }
    .actions { display: flex; gap: .8rem; align-items: center; justify-content: space-between; margin-top: 1rem; flex-wrap: wrap; }
    .note { margin: 0; color: #aab2c2; font-size: .9rem; }
    a { color: #fff; background: #436fe8; padding: .7rem 1rem; border-radius: 10px; text-decoration: none; font-weight: 700; }
    a:hover { background: #527df0; }
  </style>
</head>
<body>
  <main>
    <div class="brand">Shared with Carpo</div>
    <h1>${title}</h1>
    <video controls loop playsinline preload="metadata" src="/share/${encodedToken}/media"></video>
    <div class="actions">
      ${expiration}
      <a href="/share/${encodedToken}/download">Download MP4</a>
    </div>
  </main>
</body>
</html>`;
}

function unavailableSharePage(kind: string): Response {
  const expired = kind === "expired";
  const revoked = kind === "revoked";
  const internal = kind === "internal";
  const title = expired
    ? "This share link has expired."
    : revoked
      ? "This share link was revoked."
      : internal
        ? "This shared clip is temporarily unavailable."
        : "This shared clip is unavailable.";
  const status = expired || revoked ? 410 : internal ? 500 : 404;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared clip unavailable · Carpo</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b12;color:#f4f6fb}main{max-width:34rem;padding:2rem;text-align:center}p{color:#aab2c2}</style></head><body><main><p>Carpo</p><h1>${title}</h1><p>Ask the clip owner for a new link.</p></main></body></html>`;
  return publicResponse(html, status, { "Content-Type": "text/html; charset=utf-8" });
}

function publicResponse(
  body: BodyInit | null,
  status: number,
  extraHeaders: HeadersInit,
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Security-Policy":
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
  return new Response(body, {
    status,
    headers,
  });
}

function apiJson(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024) {
    return apiJson({ error: "Request body is too large" }, 413);
  }
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : apiJson({ error: "Request body must be an object" }, 400);
  } catch {
    return apiJson({ error: "Invalid JSON body" }, 400);
  }
}

function distributionErrorStatus(error: ClipDistributionError): number {
  switch (error.kind) {
    case "not_found":
      return 404;
    case "not_complete":
    case "unavailable":
      return 409;
    case "invalid_input":
      return 400;
    case "expired":
    case "revoked":
      return 410;
    case "internal":
      return 500;
  }
}

function allowedMethods(routes: {
  view: boolean;
  createShare: boolean;
  revokeShare: boolean;
  export: boolean;
}): string {
  if (routes.view) return "GET";
  if (routes.createShare || routes.export) return "POST";
  if (routes.revokeShare) return "DELETE";
  return "";
}

function decodedSegment(segment: string): string {
  return decodeURIComponent(segment);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeFilename(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return normalized || "carpo-clip";
}
