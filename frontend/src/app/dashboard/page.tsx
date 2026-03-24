"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LogOut, FileText } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api, type Document } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/document-upload";
import { DocumentList } from "@/components/document-list";

export default function DashboardPage() {
  const { user, logout, loading } = useAuth();
  const router = useRouter();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);

  const fetchDocuments = useCallback(async () => {
    try {
      const docs = await api.getDocuments();
      setDocuments(docs);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
      return;
    }
    if (user) fetchDocuments();
  }, [user, loading, router, fetchDocuments]);

  // Poll for processing documents
  useEffect(() => {
    const hasProcessing = documents.some((d) => d.status === "processing");
    if (!hasProcessing) return;

    const interval = setInterval(fetchDocuments, 3000);
    return () => clearInterval(interval);
  }, [documents, fetchDocuments]);

  if (loading || !user) return null;

  async function handleDelete(doc: Document) {
    if (!confirm(`Delete "${doc.original_name}"?`)) return;
    try {
      await api.deleteDocument(doc.id);
      fetchDocuments();
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-background border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            <h1 className="text-lg font-bold">PDF Q&A Bot</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{user.name}</span>
            <Button variant="ghost" size="sm" onClick={() => { logout(); router.push("/"); }}>
              <LogOut className="h-4 w-4 mr-1" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Upload a PDF</h2>
          <DocumentUpload onUploaded={fetchDocuments} />
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-4">Your Documents</h2>
          {loadingDocs ? (
            <p className="text-muted-foreground">Loading documents...</p>
          ) : (
            <DocumentList
              documents={documents}
              onOpen={(doc) => router.push(`/dashboard/${doc.id}`)}
              onDelete={handleDelete}
            />
          )}
        </div>
      </main>
    </div>
  );
}
