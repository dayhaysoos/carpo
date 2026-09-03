import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** A read-only rollout check. No application/policy writes or authentication bypass. */
export async function checkLaunchAccess(origin, fetcher = fetch) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("Use HTTPS for a hosted target");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Provide an origin without credentials, query, or path");
  const checks = [
    { path: "/", status: 200, contentType: "text/html" },
    { path: "/sign-in", status: 200, contentType: "text/html" },
    {
      path: "/share/launch-check-invalid-token",
      status: 404,
      contentType: "text/html",
    },
    ...[
      "/api/auth/login",
      "/create",
      "/library",
      "/api/me",
      "/api/videos",
      "/artifacts/launch-check-private",
      "/agents/video-clip-agent/launch-check-private",
    ].map((path) => ({ path, private: true })),
  ];
  const results = [];
  for (const check of checks) {
    const response = await fetcher(new URL(check.path, url), {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const location = response.headers.get("location");
    const redirect = location ? new URL(location, url) : null;
    const loginRedirect =
      response.status === 302 &&
      redirect?.protocol === "https:" &&
      redirect.hostname.endsWith(".cloudflareaccess.com") &&
      redirect.pathname.startsWith("/cdn-cgi/access/login/");
    const passed = check.private
      ? response.status === 401 || loginRedirect
      : response.status === check.status &&
        response.headers.get("content-type")?.includes(check.contentType);
    results.push({
      path: check.path,
      status: response.status,
      passed: Boolean(passed),
      redirect: redirect ? redirect.origin + redirect.pathname : null,
    });
    await response.body?.cancel();
  }
  return {
    origin: url.origin,
    passed: results.every((r) => r.passed),
    checks: results,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(
    await readFile(
      new URL("../config/launch-access.json", import.meta.url),
      "utf8",
    ),
  );
  const report = await checkLaunchAccess(
    process.argv[2] ?? `https://${config.hostname}`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
