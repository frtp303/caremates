export type PageToSwMessage =
  | { type: "UPLOAD_RECORDING"; recordingId: string }
  | { type: "DELETE_RECORDING"; recordingId: string; s3Key: string }
  | { type: "RETRY_ALL_UPLOADS" };

export type SwToPageMessage = {
  type: "UPLOAD_STATUS_CHANGED";
  recordingId: string;
  status: "uploading" | "synced" | "failed";
  error?: string;
};