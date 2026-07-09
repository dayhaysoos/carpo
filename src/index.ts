import { EncoderContainer } from "./encoder-container";
import type { Env } from "./env";
import { handleRequest } from "./routes";

export { EncoderContainer };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
