import { parseSubAgentPath, routeAgentRequest } from "agents";
import { getSourceVideoByIdForOwner } from "./db";
import type { Env } from "./env";
import type { AuthenticatedUser } from "./identity";

/** Route browser-facing agents only after the caller has authenticated. */
export async function routeOwnedVideoAgentRequest(
  request: Request,
  env: Pick<Env, "DB" | "VideoClipAgent">,
  user: AuthenticatedUser,
): Promise<Response | null> {
  const authorize = async (
    routedRequest: Request,
    { name }: { name: string },
  ): Promise<Response | void> => {
    // Carpo exposes no nested agents. The SDK can delegate via either a URL
    // or this internal WebSocket header, outside the root instance's identity.
    if (
      parseSubAgentPath(routedRequest.url) ||
      routedRequest.headers.has("x-cf-agents-subagent-url")
    ) {
      return Response.json(
        { error: "Agent route not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Authorize the exact instance selected by the SDK, not a second URL parser.
    const video = await getSourceVideoByIdForOwner(env.DB, name, user.id);
    if (!video) {
      return Response.json(
        { error: "Video not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
  };

  return routeAgentRequest(
    request,
    // Internal processing bindings must never become public agent destinations.
    { VideoClipAgent: env.VideoClipAgent },
    { onBeforeRequest: authorize, onBeforeConnect: authorize },
  );
}
