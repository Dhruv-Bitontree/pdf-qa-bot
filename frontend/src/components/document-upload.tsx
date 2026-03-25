"use client";

import { useState, useRef, type DragEvent } from "react";
import { Upload, Loader2, FileText } from "lucide-react";
import { Button } from "./ui/button";
import { api, type DocumentProgress } from "@/lib/api";

interface DocumentUploadProps {
  onUploaded: () => void | Promise<void>;
}

export function DocumentUpload({ onUploaded }: DocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<DocumentProgress | null>(null);
  const [completionMessage, setCompletionMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function waitForProcessing(documentId: number) {
    const startedAt = Date.now();
    const timeoutMs = 20 * 60 * 1000;

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await api.getDocumentProgress(documentId);
      setProgress(snapshot);

      if (snapshot.status === "ready" || snapshot.status === "error") {
        return snapshot;
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    throw new Error("Processing timed out. Please try again.");
  }

  async function handleFile(file: File) {
    if (uploading) return;

    const hasPdfMime = file.type === "application/pdf";
    const hasPdfExtension = /\.pdf$/i.test(file.name);
    if (!hasPdfMime && !hasPdfExtension) {
      setError("Only PDF files are accepted");
      return;
    }

    setError("");
    setCompletionMessage("");
    setProgress(null);
    setUploading(true);
    try {
      const uploaded = await api.uploadDocument(file);
      setProgress({
        document_id: uploaded.id,
        status: uploaded.status,
        stage: "starting",
        status_message: "Upload complete, processing started",
        progress_percent: 2,
        chunks_total: 0,
        chunks_processed: 0,
        extracted_image_count: 0,
      });

      const finalProgress = await waitForProcessing(uploaded.id);
      if (finalProgress.status === "error") {
        throw new Error(
          finalProgress.status_message || "Document processing failed",
        );
      }

      setCompletionMessage(
        `Done: ${finalProgress.extracted_image_count} image${finalProgress.extracted_image_count === 1 ? "" : "s"} extracted`,
      );
      await onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (uploading) return;
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          uploading
            ? "border-primary/40 bg-primary/5"
            : dragOver
              ? "border-primary bg-accent"
              : "border-border"
        }`}
      >
        {uploading ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 text-primary">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm font-medium">
                {progress?.status_message ||
                  "Uploading and preparing your PDF..."}
              </span>
            </div>
            <div className="h-2 w-full max-w-md mx-auto rounded-full bg-primary/20 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.max(2, Math.min(100, progress?.progress_percent || 2))}%`,
                }}
              />
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                {Math.round(progress?.progress_percent || 0)}% complete
                {progress?.stage ? ` • ${progress.stage}` : ""}
              </p>
              {Number(progress?.chunks_total || 0) > 0 && (
                <p>
                  Chunks processed: {progress?.chunks_processed || 0} /{" "}
                  {progress?.chunks_total || 0}
                </p>
              )}
              <p>Detected images: {progress?.extracted_image_count || 0}</p>
            </div>
          </div>
        ) : (
          <>
            <Upload className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-3">
              Drag & drop a PDF here, or click to browse
            </p>
          </>
        )}

        <Button
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              <FileText className="h-4 w-4 mr-2" />
              Select PDF
            </>
          )}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onClick={(e) => {
            e.currentTarget.value = "";
          }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.currentTarget.value = "";
          }}
        />
      </div>
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      {completionMessage && (
        <p className="text-sm text-primary mt-2">{completionMessage}</p>
      )}
    </div>
  );
}
