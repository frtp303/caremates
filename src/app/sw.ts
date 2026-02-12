/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import {
  uploadRecording,
  uploadAllPending,
  deleteRecordingFromServer,
  isNetworkError,
  type UploadResult,
} from "@/lib/upload";
import {
  addPendingDelete,
  getAllPendingDeletes,
  removePendingDelete,
} from "@/lib/audio-store";
import type { PageToSwMessage } from "@/lib/sw-messages";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();

async function broadcastStatus(result: UploadResult) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({
      type: "UPLOAD_STATUS_CHANGED",
      recordingId: result.recordingId,
      status: result.status,
      error: result.error,
    });
  }
}

async function registerSync() {
  if ("sync" in self.registration) {
    await self.registration.sync.register("upload-recordings");
  }
}

let uploadQueue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  uploadQueue = uploadQueue.then(task, task);
  return uploadQueue;
}

const isSafari =
  /Safari\//.test(navigator.userAgent) &&
  !/Chrom(e|ium)\//.test(navigator.userAgent);

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRetry(delayMs = 5_000) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    try {
      const res = await fetch("/api/health", {
        method: "HEAD",
        cache: "no-store",
        signal: abort.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        await enqueue(() => handleRetryAll());
      } else {
        scheduleRetry();
      }
    } catch {
      clearTimeout(timeout);
      scheduleRetry();
    }
  }, delayMs);
}

async function checkConnectivity(): Promise<boolean> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 3_000);
  try {
    const res = await fetch("/api/health", {
      method: "HEAD",
      cache: "no-store",
      signal: abort.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

async function handleUpload(recordingId: string) {
  if (!navigator.onLine) {
    await registerSync();
    return;
  }

  if (isSafari && !(await checkConnectivity())) {
    scheduleRetry();
    return;
  }

  await broadcastStatus({
    success: false,
    recordingId,
    status: "uploading",
  });

  const result = await uploadRecording(recordingId);

  await broadcastStatus(result);

  if (!result.success) {
    if (isSafari) {
      scheduleRetry();
    } else {
      await registerSync();
    }
  }
}

async function handleDelete(recordingId: string, s3Key: string) {
  if (!navigator.onLine) {
    await addPendingDelete({ id: recordingId, s3Key });
    await registerSync();
    return;
  }

  try {
    await deleteRecordingFromServer(s3Key, recordingId);
  } catch (err) {
    if (isNetworkError(err)) {
      await addPendingDelete({ id: recordingId, s3Key });
      if (isSafari) {
        scheduleRetry();
      } else {
        await registerSync();
      }
    }
  }
}

async function handleRetryDeletes() {
  const pending = await getAllPendingDeletes();

  for (const entry of pending) {
    try {
      const deleted = await deleteRecordingFromServer(entry.s3Key, entry.id);
      if (deleted) {
        await removePendingDelete(entry.id);
      }
    } catch {
      // Network error or timeout — leave in pending-deletes for next retry
    }
  }
}

async function handleRetryAll() {
  await handleRetryDeletes();

  const results = await uploadAllPending();
  for (const result of results) {
    await broadcastStatus(result);
  }

  const hasLocalPending = results.some((r) => r.status === "local");
  const pendingDeletes = await getAllPendingDeletes();
  if (hasLocalPending || pendingDeletes.length > 0) {
    scheduleRetry();
  }
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as PageToSwMessage;

  if (data.type === "UPLOAD_RECORDING") {
    event.waitUntil(enqueue(() => handleUpload(data.recordingId)));
  }

  if (data.type === "DELETE_RECORDING") {
    event.waitUntil(enqueue(() => handleDelete(data.recordingId, data.s3Key)));
  }

  if (data.type === "RETRY_ALL_UPLOADS") {
    event.waitUntil(enqueue(() => handleRetryAll()));
  }
});

self.addEventListener("sync", (event: SyncEvent) => {
  if (event.tag === "upload-recordings") {
    event.waitUntil(enqueue(() => handleRetryAll()));
  }
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(enqueue(() => handleRetryAll()));
});
