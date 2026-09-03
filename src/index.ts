import { isWebShellRequest, legacyLoginRedirect, loginResponse } from "./web-entry";
import { EncoderContainer } from "./encoder-container";
import type { Env } from "./env";
import { handleRequest } from "./routes";
import { VideoClipAgent } from "./video-clip-agent";
import { TranscriptPreparation } from "./transcript-preparation";
import { handleReviewAccess } from "./review-access";
import { handleReviewEvidence } from "./review-evidence";
import { routeAgentRequest } from "agents";
import { getSourceVideoByIdForOwner } from "./db";
import {
  authenticateUser,
  isMachineRequest,
  type AuthenticatedUser,
} from "./identity";
import { handlePublicClipDistribution } from "./clip-distribution-http";

export { EncoderContainer, TranscriptPreparation, VideoClipAgent };

function videoAgentName(request: Request): string | null {
  const match = new URL(request.url).pathname.match(
    /^\/agents\/(?:VideoClipAgent|video-clip-agent)\/([^/]+)(?:\/|$)/,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function authorizeAgentRequest(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
): Promise<Response | null> {
  const videoId = videoAgentName(request);
  if (!videoId) return null;
  const video = await getSourceVideoByIdForOwner(env.DB, videoId, user.id);
  return video ? null : Response.json({ error: "Video not found" }, { status: 404 });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const reviewEvidenceResponse = await handleReviewEvidence(request, env);
    if (reviewEvidenceResponse) {
      return reviewEvidenceResponse;
    }

    const reviewAccessResponse = await handleReviewAccess(request, env);
    if (reviewAccessResponse) {
      return reviewAccessResponse;
    }

    const publicDistributionResponse = await handlePublicClipDistribution(
      request,
      env,
    );
    if (publicDistributionResponse) {
      return publicDistributionResponse;
    }

    const legacyLogin = legacyLoginRedirect(request);
    if (legacyLogin) return legacyLogin;
    if (isWebShellRequest(request)) return env.ASSETS.fetch(request);

    let user: AuthenticatedUser | null = null;
    if (!isMachineRequest(request)) {
      const authentication = await authenticateUser(request, env, ctx);
      if (!authentication.ok) return authentication.response;
      user = authentication.user;
    }

    const login = loginResponse(request);
    if (login) return login;

    if (user) {
      const agentAuthorizationError = await authorizeAgentRequest(
        request,
        env,
        user,
      );
      if (agentAuthorizationError) return agentAuthorizationError;
    }

    const agentResponse = user ? await routeAgentRequest(request, env) : null;
    if (agentResponse) {
      return agentResponse;
    }
    return handleRequest(request, env, ctx, user);
  },
};
