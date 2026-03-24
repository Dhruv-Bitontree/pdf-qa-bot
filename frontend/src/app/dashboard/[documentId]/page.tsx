"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/split-pane";
import { PdfViewer } from "@/components/pdf-viewer";
import { ChatInterface } from "@/components/chat-interface";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import { api, type Document, type Source } from "@/lib/api";

export default function DocumentViewPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = use(params);
  const { user, token, loading } = useAuth();
  const router = useRouter();
  const [document, setDocument] = useState<Document | null>(null);
  const [highlights, setHighlights] = useState<Source[]>([]);
  const [focusPage, setFocusPage] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
      return;
    }
    if (user) {
      api
        .getDocument(Number(documentId))
        .then(setDocument)
        .catch(() => setError("Document not found"));
    }
  }, [user, loading, router, documentId]);

  function handleSourceClick(source: Source) {
    setHighlights([source]);
    setFocusPage(source.page_number);
  }

  if (loading || !user) return null;
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }
  if (!document) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading document...
      </div>
    );
  }

  const fileUrl = api.getDocumentFileUrl(document.id);

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="bg-background border-b border-border shrink-0">
        <div className="px-4 py-2 flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <FileText className="h-5 w-5 text-primary" />
          <span className="font-medium truncate">{document.original_name}</span>
          <Badge variant="secondary">{document.page_count} pages</Badge>
        </div>
      </header>

      {/* Split pane */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={55} minSize={30}>
            <PdfViewer
              fileUrl={fileUrl}
              token={token!}
              highlights={highlights}
              focusPage={focusPage}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={45} minSize={25}>
            <ChatInterface
              documentId={document.id}
              onSourceClick={handleSourceClick}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
