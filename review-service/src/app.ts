import { instrument } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import * as v from "valibot";
import { CarpoDurableReviewer } from "./agents/carpo-durable-reviewer";
import { handleRecording } from "./recording";
import {
  bearerToken,
  cookieValue,
  REVIEW_COOKIE,
  safeReturnPath,
  tokensMatch,
} from "./security";
import { durableReviewInitialDataSchema } from "./types";

instrument(createCloudflareTracing({ content: false }));

type AppBindings = { Bindings: Env };
const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
});

async function hasApiAccess(c: {
  env: Env;
  req: { header(name: string): string | undefined };
}) {
  if (!c.env.AUDIT_API_TOKEN) return false;
  return tokensMatch(bearerToken(c.req.header("Authorization")), c.env.AUDIT_API_TOKEN);
}

async function hasViewAccess(c: {
  env: Env;
  req: { header(name: string): string | undefined };
}) {
  if (await hasApiAccess(c)) return true;
  if (!c.env.REVIEW_VIEW_TOKEN) return false;
  return tokensMatch(
    cookieValue(c.req.header("Cookie"), REVIEW_COOKIE),
    c.env.REVIEW_VIEW_TOKEN,
  );
}

app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "carpo-durable-flue-review", version: 1 }),
);

app.use("/agents/carpo-durable-reviewer/*", async (c, next) => {
  if (!(await hasApiAccess(c))) return c.json({ error: "Unauthorized" }, 401);
  if (c.req.method === "POST" && !c.req.path.endsWith("/abort")) {
    const body = (await c.req.raw.clone().json().catch(() => null)) as {
      initialData?: unknown;
    } | null;
    if (body?.initialData !== undefined) {
      const parsed = v.safeParse(durableReviewInitialDataSchema, body.initialData);
      if (!parsed.success) return c.json({ error: "Invalid frozen review package" }, 400);
      if (
        new URL(parsed.output.candidate.reviewOrigin).origin !==
        c.env.TARGET_REVIEW_ORIGIN
      ) {
        return c.json({ error: "Review origin is outside the trusted target" }, 400);
      }
      const instanceId = decodeURIComponent(c.req.path.split("/").at(-1) ?? "");
      if (instanceId !== parsed.output.executionId) {
        return c.json({ error: "Conversation id must equal execution id" }, 400);
      }
    }
  }
  return next();
});

app.route(
  "/agents/carpo-durable-reviewer",
  createAgentRouter(CarpoDurableReviewer),
);

app.get("/api/reviews/:id", async (c) => {
  if (!(await hasViewAccess(c))) return c.json({ error: "Unauthorized" }, 401);
  const object = await c.env.EVIDENCE_BUCKET.get(
    `durable-reviews/${c.req.param("id")}/agentic-result.json`,
  );
  if (!object) return c.json({ error: "Review report not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=5",
    },
  });
});

app.get("/api/reviews/:id/evidence/:file", async (c) => {
  if (!(await hasViewAccess(c))) return c.json({ error: "Unauthorized" }, 401);
  const file = c.req.param("file");
  if (!/^agentic-[0-9]{2}\.png$/.test(file)) {
    return c.json({ error: "Invalid evidence file" }, 400);
  }
  const object = await c.env.EVIDENCE_BUCKET.get(
    `durable-reviews/${c.req.param("id")}/${file}`,
  );
  if (!object) return c.json({ error: "Evidence not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'",
    },
  });
});

app.get("/api/recordings/:sessionId", async (c) => {
  if (!(await hasViewAccess(c))) return c.json({ error: "Unauthorized" }, 401);
  return handleRecording(c.env, c.req.param("sessionId"));
});

app.get("/login", (c) => {
  const returnTo = safeReturnPath(c.req.query("returnTo"));
  return c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Carpo evidence login</title><style>body{font-family:system-ui;background:#101114;color:#f5f2ea;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(28rem,calc(100vw - 3rem));padding:2rem;border:1px solid #444;background:#191b20}input,button{box-sizing:border-box;width:100%;padding:.85rem;margin-top:1rem}button{background:#f6bd60;border:0;font-weight:700}</style></head><body><form method="post" action="/login"><h1>Private review evidence</h1><p>Enter the review viewer token.</p><input type="password" name="token" autocomplete="current-password" required><input type="hidden" name="returnTo" value="${returnTo}"><button type="submit">Open evidence</button></form></body></html>`);
});

app.post("/login", async (c) => {
  if (!c.env.REVIEW_VIEW_TOKEN) return c.text("Viewer access is not configured", 503);
  const body = await c.req.parseBody();
  const token = typeof body.token === "string" ? body.token : "";
  if (!(await tokensMatch(token, c.env.REVIEW_VIEW_TOKEN))) {
    return c.text("Unauthorized", 401);
  }
  const returnTo = safeReturnPath(
    typeof body.returnTo === "string" ? body.returnTo : undefined,
  );
  c.header(
    "Set-Cookie",
    `${REVIEW_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
  );
  return c.redirect(returnTo, 303);
});

app.get("/reports/:id", async (c) => {
  if (!(await hasViewAccess(c))) {
    return c.redirect(`/login?returnTo=${encodeURIComponent(c.req.path)}`, 303);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/agents/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
