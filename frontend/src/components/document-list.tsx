"use client";

import { FileText, Trash2, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { type Document } from "@/lib/api";
import { formatDate, formatFileSize } from "@/lib/utils";

interface DocumentListProps {
  documents: Document[];
  onOpen: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  deletingDocumentId?: number | null;
}

export function DocumentList({
  documents,
  onOpen,
  onDelete,
  deletingDocumentId = null,
}: DocumentListProps) {
  if (documents.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="mx-auto h-12 w-12 mb-3 opacity-50" />
        <p>No documents yet. Upload a PDF to get started.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {documents.map((doc) => (
        <Card
          key={doc.id}
          className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors cursor-pointer"
          onClick={() => doc.status === "ready" && onOpen(doc)}
        >
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="h-8 w-8 text-primary shrink-0" />
            <div className="min-w-0">
              <p className="font-medium truncate">{doc.original_name}</p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(doc.file_size)} &middot; {doc.page_count} pages
                &middot; {formatDate(doc.created_at)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={doc.status} />
            <Button
              variant="ghost"
              size="icon"
              disabled={deletingDocumentId === doc.id}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(doc);
              }}
            >
              {deletingDocumentId === doc.id ? (
                <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: Document["status"] }) {
  switch (status) {
    case "processing":
      return (
        <Badge variant="warning" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing
        </Badge>
      );
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
  }
}
