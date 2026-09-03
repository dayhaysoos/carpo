/** Only UI destinations may receive a login redirect. Never accept an external URL. */
export function loginDestination(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value)
  )
    return "/create";
  const url = new URL(value, "https://carpo.invalid");
  if (url.origin !== "https://carpo.invalid") return "/create";
  if (
    url.pathname !== "/create" &&
    url.pathname !== "/library" &&
    !/^\/library\/videos\/[a-zA-Z0-9-]+$/.test(url.pathname) &&
    url.pathname !== "/auth/refresh"
  )
    return "/create";
  return url.pathname + url.search;
}

/** Public shell files contain no private data; every data/media/agent route still authenticates. */
export function isWebShellRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = new URL(request.url).pathname;
  return (
    path === "/" ||
    path === "/index.html" ||
    path === "/sign-in" ||
    path === "/create" ||
    path === "/library" ||
    /^\/library\/videos\/[a-zA-Z0-9-]+$/.test(path) ||
    path === "/auth/refresh" ||
    path === "/robots.txt" ||
    path === "/favicon.svg" ||
    path.startsWith("/assets/") ||
    path.startsWith("/demo/")
  );
}

/** Preserve old entry links while sharing the API's Access destination. */
export function legacyLoginRedirect(request: Request): Response | null {
  if (new URL(request.url).pathname !== "/auth/login") return null;
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const destination = loginDestination(new URL(request.url).searchParams.get("returnTo"));
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/api/auth/login?returnTo=${encodeURIComponent(destination)}`,
      "Cache-Control": "no-store",
    },
  });
}

export function loginResponse(request: Request): Response | null {
  if (new URL(request.url).pathname !== "/api/auth/login") return null;
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  // Called only after authenticateUser, including in explicitly local legacy mode.
  const destination = loginDestination(
    new URL(request.url).searchParams.get("returnTo"),
  );
  return new Response(null, {
    status: 303,
    headers: { Location: destination, "Cache-Control": "no-store" },
  });
}
