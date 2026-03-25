"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  FileText,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api, type Document } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DocumentUpload } from "@/components/document-upload";
import { DocumentList } from "@/components/document-list";

export default function DashboardPage() {
  const { user, logout, loading } = useAuth();
  const router = useRouter();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalDocs, setTotalDocs] = useState(0);
  const [deletingDocumentId, setDeletingDocumentId] = useState<number | null>(
    null,
  );

  const fetchDocuments = useCallback(async () => {
    try {
      const result = await api.getDocumentsPage({
        page,
        pageSize: 5,
        q: debouncedQuery,
      });
      setDocuments(result.items);
      setTotalDocs(result.total);
      setTotalPages(result.totalPages);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoadingDocs(false);
    }
  }, [page, debouncedQuery]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery]);

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
    if (deletingDocumentId !== null) return;
    if (!confirm(`Delete "${doc.original_name}"?`)) return;
    try {
      setDeletingDocumentId(doc.id);
      await api.deleteDocument(doc.id);
      await fetchDocuments();
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingDocumentId(null);
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                logout();
                router.push("/");
              }}
            >
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
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Your Documents</h2>
              <p className="text-sm text-muted-foreground">
                {totalDocs} total document{totalDocs === 1 ? "" : "s"}
              </p>
            </div>
            <div className="w-full md:w-[360px]">
              <label className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                AI Search
              </label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by file name, AI title, or summary"
              />
            </div>
          </div>
          {loadingDocs ? (
            <p className="text-muted-foreground">Loading documents...</p>
          ) : (
            <>
              <DocumentList
                documents={documents}
                onOpen={(doc) => router.push(`/dashboard/${doc.id}`)}
                onDelete={handleDelete}
                deletingDocumentId={deletingDocumentId}
              />
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Prev
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
