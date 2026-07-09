const STORAGE_KEY = "carpo:job-ids";

export function loadJobIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveJobIds(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function addJobId(id: string): string[] {
  const existing = loadJobIds();
  if (existing.includes(id)) {
    return existing;
  }
  const next = [id, ...existing];
  saveJobIds(next);
  return next;
}

export function removeJobId(id: string): string[] {
  const next = loadJobIds().filter((jobId) => jobId !== id);
  saveJobIds(next);
  return next;
}
