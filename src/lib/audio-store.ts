export interface Recording {
  id: string;
  filename: string;
  blob: Blob;
  fileSize: number;
  duration: number;
  recordedAt: string;
  status: "local" | "uploading" | "synced" | "failed";
  s3Key?: string;
  uploadAttempts: number;
  lastError?: string;
}

export interface SyncedRecording {
  id: string;
  filename: string;
  fileSize: number;
  duration: number;
  recordedAt: string;
  status: "synced";
  s3Key: string;
}

export type DisplayRecording =
  | (Recording & { source: "local" })
  | (SyncedRecording & { source: "remote" });

export interface PendingDelete {
  id: string;
  s3Key: string;
}

const DB_NAME = "caremates";
const STORE_NAME = "recordings";
const PENDING_DELETES_STORE = "pending-deletes";
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PENDING_DELETES_STORE)) {
        db.createObjectStore(PENDING_DELETES_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Safari does not support storing Blobs in IndexedDB. We store the raw bytes
// as an ArrayBuffer + mimeType and reconstruct the Blob on read.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hydrateRecording(raw: any): Recording {
  if (raw.blob instanceof Blob) return raw as Recording;
  const { data, mimeType, ...rest } = raw;
  return { ...rest, blob: new Blob([data], { type: mimeType || "audio/webm" }) };
}

export async function saveRecording(recording: Recording): Promise<void> {
  const db = await openDB();
  const data = await recording.blob.arrayBuffer();
  const { blob, ...rest } = recording;
  const storable = { ...rest, data, mimeType: blob.type };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(storable);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllRecordings(): Promise<Recording[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.map(hydrateRecording));
    request.onerror = () => reject(request.error);
  });
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getRecordingById(
  id: string,
): Promise<Recording | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () =>
      resolve(request.result ? hydrateRecording(request.result) : undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getRecordingsByStatus(
  ...statuses: Recording["status"][]
): Promise<Recording[]> {
  const all = await getAllRecordings();
  return all.filter((r) => statuses.includes(r.status));
}

export async function updateRecordingStatus(
  id: string,
  status: Recording["status"],
  extras?: { uploadAttempts?: number; lastError?: string; s3Key?: string },
): Promise<Recording | undefined> {
  const db = await openDB();

  // Read the raw stored record (ArrayBuffer format) to avoid re-serializing the blob.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(request.error);
  });

  if (!raw) return undefined;

  const updated = {
    ...raw,
    status,
    ...(extras?.uploadAttempts !== undefined && {
      uploadAttempts: extras.uploadAttempts,
    }),
    ...(extras?.s3Key !== undefined && {
      s3Key: extras.s3Key,
    }),
    ...(extras?.lastError !== undefined
      ? { lastError: extras.lastError }
      : status === "synced"
        ? { lastError: undefined }
        : {}),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(updated);
    tx.oncomplete = () => resolve(hydrateRecording(updated));
    tx.onerror = () => reject(tx.error);
  });
}

export async function addPendingDelete(entry: PendingDelete): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_DELETES_STORE, "readwrite");
    tx.objectStore(PENDING_DELETES_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPendingDeletes(): Promise<PendingDelete[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_DELETES_STORE, "readonly");
    const request = tx.objectStore(PENDING_DELETES_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function removePendingDelete(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_DELETES_STORE, "readwrite");
    tx.objectStore(PENDING_DELETES_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
