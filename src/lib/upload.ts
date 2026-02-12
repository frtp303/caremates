import {
  getRecordingById,
  getRecordingsByStatus,
  updateRecordingStatus,
  deleteRecording,
  type Recording,
} from "./audio-store";

const MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

class UploadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "UploadError";
    this.retryable = retryable;
  }
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timeout),
  );
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof UploadError) return error.retryable;
  return false;
}

function backoffDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = 0.5 + Math.random();
  return base * jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UploadUrlResponse {
  url: string;
  key: string;
}

export interface UploadResult {
  success: boolean;
  recordingId: string;
  status: Recording["status"];
  error?: string;
}

async function getPresignedUrl(
  filename: string,
): Promise<UploadUrlResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout("/api/trpc/audio.getUploadUrl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { filename } }),
    });
  } catch (err) {
    if (isNetworkError(err)) throw err;
    throw new UploadError("Failed to get presigned URL", false);
  }

  if (!response.ok) {
    throw new UploadError(
      `Failed to get presigned URL: ${response.status}`,
      isRetryableStatus(response.status),
    );
  }

  const data = await response.json();
  return data.result.data.json as UploadUrlResponse;
}

async function putToS3(
  url: string,
  blob: Blob,
  contentType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });
  } catch (err) {
    if (isNetworkError(err)) throw err;
    throw new UploadError("S3 upload failed", false);
  }

  if (!response.ok) {
    throw new UploadError(
      `S3 upload failed: ${response.status}`,
      isRetryableStatus(response.status),
    );
  }
}

async function saveRecordingToDb(data: {
  id: string;
  filename: string;
  s3Key?: string;
  fileSize: number;
  duration: number;
  recordedAt: string;
  status: "synced" | "failed";
  lastError?: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout("/api/trpc/audio.saveRecording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: data }),
    });
  } catch (err) {
    if (isNetworkError(err)) throw err;
    throw new UploadError("Failed to save to database", false);
  }

  if (!response.ok) {
    throw new UploadError(
      `Failed to save to database: ${response.status}`,
      isRetryableStatus(response.status),
    );
  }
}

export async function uploadRecording(
  recordingId: string,
): Promise<UploadResult> {
  const recording = await getRecordingById(recordingId);
  if (!recording) {
    return {
      success: false,
      recordingId,
      status: "failed",
      error: "Recording not found",
    };
  }

  if (recording.status === "synced") {
    return { success: true, recordingId, status: "synced" };
  }

  if (recording.uploadAttempts >= MAX_ATTEMPTS) {
    return {
      success: false,
      recordingId,
      status: "failed",
      error: recording.lastError ?? "Maximum upload attempts reached",
    };
  }

  let s3Key = recording.s3Key;
  let lastError: string | undefined;
  const startAttempt = recording.uploadAttempts;

  for (let attempt = startAttempt; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > startAttempt) {
      await sleep(backoffDelay(attempt - 1));
    }

    await updateRecordingStatus(recordingId, "uploading", {
      uploadAttempts: attempt + 1,
    });

    try {
      if (!s3Key) {
        const contentType = recording.blob.type || "audio/webm";
        const { url, key } = await getPresignedUrl(recording.filename);
        await putToS3(url, recording.blob, contentType);
        s3Key = key;
        await updateRecordingStatus(recordingId, "uploading", {
          s3Key: key,
        });
      }

      await saveRecordingToDb({
        id: recording.id,
        filename: recording.filename,
        s3Key,
        fileSize: recording.fileSize,
        duration: recording.duration,
        recordedAt: recording.recordedAt,
        status: "synced",
      });

      await deleteRecording(recordingId);
      return { success: true, recordingId, status: "synced" };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown error";

      if (isNetworkError(err)) {
        await updateRecordingStatus(recordingId, "local", {
          uploadAttempts: startAttempt,
        });
        return { success: false, recordingId, status: "local", error: lastError };
      }

      if (!isRetryableError(err)) break;
      if (attempt + 1 >= MAX_ATTEMPTS) break;
    }
  }

  await updateRecordingStatus(recordingId, "failed", {
    uploadAttempts: MAX_ATTEMPTS,
    lastError,
  });

  try {
    await saveRecordingToDb({
      id: recording.id,
      filename: recording.filename,
      s3Key: s3Key ?? undefined,
      fileSize: recording.fileSize,
      duration: recording.duration,
      recordedAt: recording.recordedAt,
      status: "failed",
      lastError,
    });
  } catch {
    // If server database is the reason for failure the audio will be persisted to
    // the IndexedDB. A log in the server will let the team know what is going wrong
    // with our database and a manual retry can be done later.
  }

  return {
    success: false,
    recordingId,
    status: "failed",
    error: lastError,
  };
}

export async function deleteRecordingFromServer(
  s3Key: string,
  id: string,
): Promise<boolean> {
  const response = await fetchWithTimeout("/api/trpc/audio.deleteRecording", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: { s3Key, id } }),
  });
  return response.ok;
}

export async function uploadAllPending(): Promise<UploadResult[]> {
  const pending = await getRecordingsByStatus("local", "uploading");
  const results: UploadResult[] = [];

  for (const recording of pending) {
    const result = await uploadRecording(recording.id);
    results.push(result);
  }

  return results;
}
