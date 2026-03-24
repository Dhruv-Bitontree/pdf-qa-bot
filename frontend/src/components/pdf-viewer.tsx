"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./ui/button";
import type { Source } from "@/lib/api";

interface PdfViewerProps {
  fileUrl: string;
  token: string;
  highlights?: Source[];
  focusPage?: number | null;
}

export function PdfViewer({ fileUrl, token, highlights = [], focusPage }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Load PDF
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setLoading(true);
        setError("");

        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

        const loadingTask = pdfjsLib.getDocument({
          url: fileUrl,
          httpHeaders: { Authorization: `Bearer ${token}` },
        });

        const pdfDoc = await loadingTask.promise;
        if (!cancelled) {
          setPdf(pdfDoc);
          setTotalPages(pdfDoc.numPages);
          setCurrentPage(1);
        }
      } catch (err) {
        if (!cancelled) {
          setError("Failed to load PDF");
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();
    return () => { cancelled = true; };
  }, [fileUrl, token]);

  // Navigate to focused page
  useEffect(() => {
    if (focusPage && focusPage >= 1 && focusPage <= totalPages) {
      setCurrentPage(focusPage);
    }
  }, [focusPage, totalPages]);

  // Render page
  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return;

    try {
      const page = await pdf.getPage(currentPage);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Draw highlight overlays
      const pageHighlights = highlights.filter((h) => h.page_number === currentPage);
      if (pageHighlights.length > 0) {
        ctx.fillStyle = "rgba(254, 240, 138, 0.4)";
        // Simple highlight: draw a band for each source on this page
        const bandHeight = viewport.height / 10;
        pageHighlights.forEach((h, i) => {
          const y = Math.min(i * bandHeight * 2, viewport.height - bandHeight);
          ctx.fillRect(10, y, viewport.width - 20, bandHeight);
        });
      }
    } catch (err) {
      console.error("Error rendering page:", err);
    }
  }, [pdf, currentPage, scale, highlights]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading PDF...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/50 shrink-0">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums px-2">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs tabular-nums w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 overflow-auto flex justify-center p-4 bg-muted/30">
        <canvas ref={canvasRef} className="shadow-lg" />
      </div>
    </div>
  );
}
