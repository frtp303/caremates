"use client";

import { useCallback, useEffect, useState } from "react";
import { RecordButton } from "@/components/record-button";
import { RecordingsList } from "@/components/recordings-list";
import {
  saveRecording,
  getAllRecordings,
  deleteRecording,
  updateRecordingStatus,
  type Recording,
  type DisplayRecording,
} from "@/lib/audio-store";
import { uploadRecording } from "@/lib/upload";
import { trpc } from "@/lib/trpc/client";
import type { SwToPageMessage } from "@/lib/sw-messages";

function postToSW(message: Record<string, unknown>) {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(message);
    return;
  }
  navigator.serviceWorker?.ready.then((reg) => {
    reg.active?.postMessage(message);
  });
}

function triggerUpload(recordingId: string) {
  postToSW({ type: "UPLOAD_RECORDING", recordingId });
}

export default function Home() {
  const [recordings, setRecordings] = useState<DisplayRecording[]>([]);

  const {
    data: syncedRecordings,
    refetch: refetchSynced,
  } = trpc.audio.listRecordings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    getAllRecordings().then((localRecs) => {
      const stale = localRecs.filter((r) => r.status === "synced");
      stale.forEach((r) => deleteRecording(r.id));

      const localDisplay: DisplayRecording[] = localRecs
        .filter((r) => r.status !== "synced")
        .map((r) => ({ ...r, source: "local" as const }));

      setRecordings((prev) => {
        const existingRemote = prev.filter((r) => r.source === "remote");
        return [...localDisplay, ...existingRemote].sort(
          (a, b) =>
            new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
        );
      });
    });
  }, []);

  useEffect(() => {
    if (!syncedRecordings) return;

    setRecordings((prev) => {
      const incomingRemote = new Map(
       syncedRecordings.map((r) => [
         r.id,
         { ...r, source: "remote" as const } as DisplayRecording,
       ]),
      );

      const handledIds = new Set<string>();
      const merged: DisplayRecording[] = [];

      for (const r of prev) {
        if (r.source === "local") {
          if (incomingRemote.has(r.id)) {
            merged.push(incomingRemote.get(r.id)!);
            handledIds.add(r.id);
          } else {
            merged.push(r);
          }
        } else {
          if (incomingRemote.has(r.id)) {
            const fresh = incomingRemote.get(r.id)!;
            const changed =
             r.status !== fresh.status ||
             r.filename !== fresh.filename ||
             r.duration !== fresh.duration ||
             r.s3Key !== fresh.s3Key;
            merged.push(changed ? fresh : r);
            handledIds.add(r.id);
          }
        }
      }

      for (const [id, r] of incomingRemote) {
        if (!handledIds.has(id)) {
          merged.push(r);
        }
      }

      if (
       merged.length === prev.length &&
       merged.every((r, i) => r === prev[i])
      ) {
        return prev;
      }

      return merged.sort(
       (a, b) =>
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
      );
    });
  }, [syncedRecordings]);

  useEffect(() => {
    const handler = (event: MessageEvent<SwToPageMessage>) => {
      if (event.data.type === "UPLOAD_STATUS_CHANGED") {
        if (event.data.status === "synced") {
          setRecordings((prev) =>
            prev.map((r) => {
              if (r.id !== event.data.recordingId) return r;
              return {
                id: r.id,
                filename: r.filename,
                fileSize: r.fileSize,
                duration: r.duration,
                recordedAt: r.recordedAt,
                status: "synced" as const,
                s3Key: `recordings/${r.filename}`,
                source: "remote" as const,
              };
            }),
          );
          refetchSynced();
        } else {
          setRecordings((prev) =>
            prev.map((r) =>
              r.id === event.data.recordingId && r.source === "local"
                ? { ...r, status: event.data.status, lastError: event.data.error }
                : r,
            ),
          );
        }
      }
    };

    navigator.serviceWorker?.addEventListener("message", handler);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handler);
    };
  }, [refetchSynced]);

  useEffect(() => {
    navigator.storage?.persist();
  }, []);

  useEffect(() => {
    postToSW({ type: "RETRY_ALL_UPLOADS" });
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const recording = recordings.find((r) => r.id === id);
      if (!recording) return;

      setRecordings((prev) => prev.filter((r) => r.id !== id));

      if (recording.source === "local") {
        await deleteRecording(id);
        if (recording.s3Key) {
          postToSW({ type: "DELETE_RECORDING", recordingId: id, s3Key: recording.s3Key });
        }
      } else {
        postToSW({
          type: "DELETE_RECORDING",
          recordingId: id,
          s3Key: recording.s3Key,
        });
      }
    },
    [recordings],
  );

  const handleRecordingComplete = useCallback(
    async (blob: Blob, duration: number) => {
      const id = crypto.randomUUID();
      const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "m4a" : "ogg";
      const recording: Recording = {
        id,
        filename: `recording-${id.slice(0, 8)}.${ext}`,
        blob,
        fileSize: blob.size,
        duration,
        recordedAt: new Date().toISOString(),
        status: "local",
        uploadAttempts: 0,
      };

      await saveRecording(recording);
      setRecordings((prev) => [{ ...recording, source: "local" as const }, ...prev]);

      if (navigator.serviceWorker?.controller) {
        triggerUpload(id);
      } else if (navigator.onLine) {
        const result = await uploadRecording(id);
        if (result.status === "synced") {
          setRecordings((prev) =>
            prev.map((r) => {
              if (r.id !== id) return r;
              return {
                id: r.id,
                filename: r.filename,
                fileSize: r.fileSize,
                duration: r.duration,
                recordedAt: r.recordedAt,
                status: "synced" as const,
                s3Key: `recordings/${r.filename}`,
                source: "remote" as const,
              };
            }),
          );
          refetchSynced();
        } else {
          setRecordings((prev) =>
            prev.map((r) =>
              r.id === id && r.source === "local"
                ? { ...r, status: result.status, lastError: result.error }
                : r,
            ),
          );
        }
      }
    },
    [refetchSynced],
  );

  const handleRetry = useCallback(
    async (id: string) => {
      await updateRecordingStatus(id, "local", { uploadAttempts: 0 });
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === id && r.source === "local"
            ? { ...r, status: "local" as const }
            : r,
        ),
      );

      if (navigator.serviceWorker?.controller) {
        triggerUpload(id);
      } else if (navigator.onLine) {
        const result = await uploadRecording(id);
        if (result.status === "synced") {
          setRecordings((prev) =>
            prev.map((r) => {
              if (r.id !== id) return r;
              return {
                id: r.id,
                filename: r.filename,
                fileSize: r.fileSize,
                duration: r.duration,
                recordedAt: r.recordedAt,
                status: "synced" as const,
                s3Key: `recordings/${r.filename}`,
                source: "remote" as const,
              };
            }),
          );
          refetchSynced();
        } else {
          setRecordings((prev) =>
            prev.map((r) =>
              r.id === id && r.source === "local"
                ? { ...r, status: result.status, lastError: result.error }
                : r,
            ),
          );
        }
      }
    },
    [refetchSynced],
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-12">
      <div className="flex flex-1 items-center justify-center">
        <RecordButton onRecordingComplete={handleRecordingComplete} />
      </div>

      <div className="mt-8">
        <div className="mb-4 border-b border-zinc-200 pb-2 dark:border-zinc-700">
          <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-200">
            Recordings
          </h2>
        </div>
        <RecordingsList
          recordings={recordings}
          onDelete={handleDelete}
          onRetry={handleRetry}
        />
      </div>
    </div>
  );
}
