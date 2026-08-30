export type MediaDeliveryMethod = "GET" | "HEAD";

export interface MediaDeliveryRequest {
  key: string;
  method: MediaDeliveryMethod;
  range: string | null;
}

export type MediaDeliveryOutcome =
  | { type: "delivered"; response: Response }
  | { type: "missing" }
  | { type: "range-not-satisfiable"; headers: Headers };

interface ResolvedRange {
  offset: number;
  length: number;
}

type RangeResolution =
  | { type: "partial"; range: ResolvedRange }
  | { type: "invalid" };

/**
 * Delivers one R2 object over HTTP without making authorization or presentation
 * decisions for its callers.
 */
export class R2MediaDelivery {
  constructor(private readonly bucket: Pick<R2Bucket, "get" | "head">) {}

  async deliver(request: MediaDeliveryRequest): Promise<MediaDeliveryOutcome> {
    if (request.range !== null) {
      return this.deliverRange(request, request.range);
    }

    if (request.method === "HEAD") {
      const object = await this.bucket.head(request.key);
      if (!object) return { type: "missing" };
      return {
        type: "delivered",
        response: responseFor(object, null, null),
      };
    }

    const object = await this.bucket.get(request.key);
    if (!object || !("body" in object)) return { type: "missing" };
    return {
      type: "delivered",
      response: responseFor(object, object.body, null),
    };
  }

  private async deliverRange(
    request: MediaDeliveryRequest,
    rangeHeader: string,
  ): Promise<MediaDeliveryOutcome> {
    const metadata = await this.bucket.head(request.key);
    if (!metadata) return { type: "missing" };

    const resolution = resolveRange(rangeHeader, metadata.size);
    if (resolution.type === "invalid") {
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Range": `bytes */${metadata.size}`,
      });
      return { type: "range-not-satisfiable", headers };
    }
    if (request.method === "HEAD") {
      return {
        type: "delivered",
        response: responseFor(metadata, null, resolution.range),
      };
    }

    const object = await this.bucket.get(request.key, {
      range: resolution.range,
    });
    if (!object || !("body" in object)) return { type: "missing" };
    return {
      type: "delivered",
      response: responseFor(object, object.body, resolution.range, metadata.size),
    };
  }
}

function responseFor(
  object: R2Object,
  body: BodyInit | null,
  range: ResolvedRange | null,
  objectSize = object.size,
): Response {
  const headers = deliveryHeaders(object);
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${objectSize}`,
    );
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(objectSize));
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

function deliveryHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

function resolveRange(value: string, objectSize: number): RangeResolution {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { type: "invalid" };

  const start = match[1] ? parseSafeInteger(match[1]) : null;
  const end = match[2] ? parseSafeInteger(match[2]) : null;
  if ((match[1] && start === null) || (match[2] && end === null)) {
    return { type: "invalid" };
  }

  if (start === null) {
    if (end === null || end === 0 || objectSize === 0) {
      return { type: "invalid" };
    }
    const length = Math.min(end, objectSize);
    return {
      type: "partial",
      range: { offset: objectSize - length, length },
    };
  }

  if (start >= objectSize || (end !== null && end < start)) {
    return { type: "invalid" };
  }
  const finalByte = end === null ? objectSize - 1 : Math.min(end, objectSize - 1);
  return {
    type: "partial",
    range: { offset: start, length: finalByte - start + 1 },
  };
}

function parseSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
