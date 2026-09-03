import { isWebShellRequest, legacyLoginRedirect, loginResponse } from "./web-entry";
import { EncoderContainer } from "./encoder-container";
import type { Env } from "./env";
import { handleRequest } from "./routes";
import { VideoClipAgent } from "./video-clip-agent";
import { TranscriptPreparation } from "./transcript-preparation";
import { handleReviewAccess } from "./review-access";
import { handleReviewEvidence } from "./review-evidence";
import { routeOwnedVideoAgentRequest } from "./agent-routing";
import {
  authenticateUser,
  isMachineRequest,
  type AuthenticatedUser,
} from "./identity";
import { handlePublicClipDistribution } from "./clip-distribution-http";

export { EncoderContainer, TranscriptPreparation, VideoClipAgent };

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

    const agentResponse = user
      ? await routeOwnedVideoAgentRequest(request, env, user)
      : null;
    if (agentResponse) {
      return agentResponse;
    }
    return handleRequest(request, env, ctx, user);
  },
};
