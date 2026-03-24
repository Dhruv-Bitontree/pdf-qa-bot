"use client";

import { useState, useRef, type DragEvent } from "react";
import { Upload, Loader2, FileText } from "lucide-react";
import { Button } from "./ui/button";
import { api } from "@/lib/api";

interface DocumentUploadProps {
  onUploaded: () => void | Promise<void>;
}

export function DocumentUpload({ onUploaded }: DocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (uploading) return;

    const hasPdfMime = file.type === "application/pdf";
    const hasPdfExtension = /\.pdf$/i.test(file.name);
    if (!hasPdfMime && !hasPdfExtension) {
      setError("Only PDF files are accepted");
      return;
    }

    setError("");
    setUploading(true);
    try {
      await api.uploadDocument(file);
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
                Uploading and preparing your PDF...
              </span>
            </div>
            <div className="h-2 w-full max-w-md mx-auto rounded-full bg-primary/20 overflow-hidden">
              <div className="h-full w-1/3 rounded-full bg-primary/80 upload-progress-sweep" />
            </div>
            <p className="text-xs text-muted-foreground">
              Extracting content and building search index.
            </p>
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
    </div>
  );
}
