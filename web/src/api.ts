import type { ApiError, ClipListResponse, ClipResponse, CreateClipRequest } from "./types";

export async function createClip(
  request: CreateClipRequest,
): Promise<ClipResponse> {
  const response = await fetch("/api/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    const detail = body.details?.map((d) => d.message).join("; ");
    throw new Error(detail || body.error || `Request failed (${response.status})`);
  }

  return response.json() as Promise<ClipResponse>;
}

export async function getClip(id: string): Promise<ClipResponse> {
  const response = await fetch(`/api/clips/${id}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipResponse>;
}

export async function listClips(
  limit = 50,
  offset = 0,
): Promise<ClipListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const response = await fetch(`/api/clips?${params}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<ClipListResponse>;
}

export async function deleteClip(id: string): Promise<void> {
  const response = await fetch(`/api/clips/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(body.error || `Request failed (${response.status})`);
  }
}
