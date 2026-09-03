import assert from "node:assert/strict";
import test from "node:test";
import { checkLaunchAccess } from "./check-launch-access.mjs";

test("checks public reachability and private denial without following redirects", async () => {
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.pathname.startsWith("/share/"))
      return new Response("unavailable", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    if (url.pathname === "/" || url.pathname === "/sign-in")
      return new Response("Carpo", {
        headers: { "content-type": "text/html" },
      });
    return new Response(null, {
      status: 302,
      headers: {
        location:
          "https://team.cloudflareaccess.com/cdn-cgi/access/login/carpo.example?token=never-print",
      },
    });
  };
  const result = await checkLaunchAccess("https://carpo.example", fetcher);
  assert.equal(result.passed, true);
  assert.equal(JSON.stringify(result).includes("never-print"), false);
});
test("fails a Worker-wide login gate and an exposed API", async () => {
  const result = await checkLaunchAccess(
    "https://carpo.example",
    async () =>
      new Response("public", { headers: { "content-type": "text/html" } }),
  );
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((c) => c.path === "/api/me").passed, false);
});
