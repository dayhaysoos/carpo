import { EncoderContainer } from "./encoder-container";
import type { Env } from "./env";
import { handleRequest } from "./routes";
import { VideoClipAgent } from "./video-clip-agent";
import { TranscriptPreparation } from "./transcript-preparation";
import { routeAgentRequest } from "agents";

export { EncoderContainer, TranscriptPreparation, VideoClipAgent };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }
    return handleRequest(request, env, ctx);
  },
};
