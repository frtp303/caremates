"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const LOW_STORAGE_THRESHOLD = 50 * 1024 * 1024;

interface RecordButtonProps {
  onRecordingComplete: (blob: Blob, duration: number) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function RecordButton({ onRecordingComplete }: RecordButtonProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError(null);

      if (typeof MediaRecorder === "undefined") {
        setError("Recording is not supported on this browser.");
        return;
      }

      if (navigator.storage?.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        if (quota && usage && quota - usage < LOW_STORAGE_THRESHOLD) {
          setStorageWarning(true);
          return;
        }
      }
      setStorageWarning(false);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const candidates = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t));

      if (!mimeType) {
        stream.getTracks().forEach((t) => t.stop());
        setError("No supported audio format found on this browser.");
        return;
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const duration = Math.round((Date.now() - startTimeRef.current) / 1000);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        onRecordingComplete(blob, duration);
      };

      startTimeRef.current = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      mediaRecorder.start();
      setRecording(true);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was denied. Please allow microphone access and try again."
          : "Could not start recording. Please check your microphone permissions.";
      setError(message);
    }
  }, [onRecordingComplete]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        onClick={recording ? stopRecording : startRecording}
        className={`flex h-40 w-40 items-center justify-center rounded-full border-2 transition-all ${
          recording
            ? "border-red-400 bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400"
            : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500"
        }`}
      >
        <span className="text-lg font-medium">
          {recording ? "Stop" : "Record"}
        </span>
      </button>
      {recording && (
        <span className="font-mono text-lg text-red-600 dark:text-red-400">
          {formatTime(elapsed)}
        </span>
      )}
      {storageWarning && (
        <p className="max-w-xs text-center text-sm text-red-500 dark:text-red-400">
          Storage is almost full. Delete some recordings to free up space.
        </p>
      )}
      {error && (
        <p className="max-w-xs text-center text-sm text-red-500 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
