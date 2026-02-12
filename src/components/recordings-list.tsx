"use client";

import { useRef, useState } from "react";
import type { DisplayRecording } from "@/lib/audio-store";
import { trpc } from "@/lib/trpc/client";

interface RecordingsListProps {
  recordings: DisplayRecording[];
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const statusStyles = {
  local:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  uploading:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  synced:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
} as const;

const statusLabels = {
  local: "Local",
  uploading: "Uploading",
  synced: "Synced",
  failed: "Failed",
} as const;

function RecordingRow({
  recording,
  onDelete,
  onRetry,
}: {
  recording: DisplayRecording;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const utils = trpc.useUtils();

  async function getAudioUrl(): Promise<string> {
    if (urlRef.current) return urlRef.current;

    if (recording.source === "local") {
      urlRef.current = URL.createObjectURL(recording.blob);
    } else {
      const { url } = await utils.audio.getPlaybackUrl.fetch({
        s3Key: recording.s3Key,
      });
      urlRef.current = url;
    }

    return urlRef.current;
  }

  async function handleDownload() {
    try {
      if (recording.source === "local") {
        const blobUrl = URL.createObjectURL(recording.blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = recording.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } else {
        // Open tab immediately to preserve user gesture (avoids popup blocker)
        const win = window.open("", "_blank");
        const { url } = await utils.audio.getDownloadUrl.fetch({
          s3Key: recording.s3Key,
          filename: recording.filename,
        });
        if (win) win.location.href = url;
      }
    } catch (err) {
      console.error("Download failed:", err);
    }
  }

  async function handlePlay() {
    if (audioRef.current && playing) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }

    if (audioRef.current) {
      audioRef.current.play();
      setPlaying(true);
      return;
    }

    if (recording.source === "remote" && !navigator.onLine) {
      setPlayError("No internet connection");
      return;
    }

    setPlayError(null);
    setLoading(true);
    try {
      const url = await getAudioUrl();
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.addEventListener("timeupdate", () => {
        if (audio.duration) {
          setProgress(audio.currentTime / audio.duration);
        }
      });

      audio.addEventListener("ended", () => {
        setPlaying(false);
        setProgress(0);
      });

      await Promise.race([
        audio.play(),
        new Promise<never>((_, reject) => {
          audio.addEventListener("error", () =>
            reject(new Error("Audio failed to load")),
          );
          setTimeout(() => reject(new Error("Playback timed out")), 10_000);
        }),
      ]);
      setPlaying(true);
    } catch (err) {
      console.error("Playback failed:", err);
      audioRef.current = null;
      urlRef.current = null;
      setPlayError("Unable to play the recording right now");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${statusStyles[recording.status]}`}
          >
            {statusLabels[recording.status]}
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {recording.filename}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {formatDuration(recording.duration)} · {formatDate(recording.recordedAt)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePlay}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            {loading ? "Loading..." : playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={handleDownload}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Download
          </button>
          {recording.source === "local" && recording.status === "failed" && (
            <button
              onClick={() => onRetry(recording.id)}
              className="text-sm font-medium text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-300"
            >
              Retry
            </button>
          )}
          <button
            onClick={() => onDelete(recording.id)}
            className="text-sm font-medium text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          >
            Delete
          </button>
        </div>
      </div>
      {recording.source === "local" && recording.status === "failed" && (
        <p className="mt-2 text-xs text-red-500 dark:text-red-400">
          Upload failed. Please try again later.
        </p>
      )}
      {playError && (
        <p className="mt-2 text-xs text-red-500 dark:text-red-400">
          {playError}
        </p>
      )}
      {(playing || progress > 0) && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <div
            className="h-full rounded-full bg-zinc-500 dark:bg-zinc-400"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function RecordingsList({
  recordings,
  onDelete,
  onRetry,
}: RecordingsListProps) {
  if (recordings.length === 0) {
    return (
      <p className="text-center text-sm text-zinc-400 dark:text-zinc-500">
        No recordings yet
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {recordings.map((rec) => (
        <RecordingRow
          key={rec.id}
          recording={rec}
          onDelete={onDelete}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}