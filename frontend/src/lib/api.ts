const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (!this.token && typeof window !== "undefined") {
      this.token = localStorage.getItem("pdf-qa-token");
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    // Don't set Content-Type for FormData (browser sets it with boundary)
    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  resolveApiUrl(pathOrUrl: string) {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      return pathOrUrl;
    }

    if (pathOrUrl.startsWith("/api/")) {
      return `${API_URL}${pathOrUrl.slice(4)}`;
    }

    if (pathOrUrl.startsWith("/")) {
      return `${API_URL}${pathOrUrl}`;
    }

    return `${API_URL}/${pathOrUrl}`;
  }

  async downloadAuthenticatedFile(pathOrUrl: string, filename?: string) {
    const headers: Record<string, string> = {};

    if (!this.token && typeof window !== "undefined") {
      this.token = localStorage.getItem("pdf-qa-token");
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const res = await fetch(this.resolveApiUrl(pathOrUrl), { headers });
    if (!res.ok) {
      throw new Error(`Download failed (HTTP ${res.status})`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async fetchAuthenticatedBlobUrl(pathOrUrl: string) {
    const headers: Record<string, string> = {};

    if (!this.token && typeof window !== "undefined") {
      this.token = localStorage.getItem("pdf-qa-token");
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const res = await fetch(this.resolveApiUrl(pathOrUrl), { headers });
    if (!res.ok) {
      throw new Error(`Preview load failed (HTTP ${res.status})`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // Auth
  async register(email: string, password: string, name: string) {
    return this.request<{ user: User; token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
  }

  async login(email: string, password: string) {
    return this.request<{ user: User; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  // Documents
  async getDocuments() {
    return this.request<Document[]>("/documents");
  }

  async getDocumentsPage(params: {
    page?: number;
    pageSize?: number;
    q?: string;
  }) {
    const search = new URLSearchParams();
    search.set("page", String(Math.max(1, Math.trunc(params.page || 1))));
    search.set(
      "pageSize",
      String(Math.max(1, Math.trunc(params.pageSize || 5))),
    );
    if (params.q && params.q.trim()) {
      search.set("q", params.q.trim());
    }
    return this.request<DocumentsPageResult>(`/documents?${search.toString()}`);
  }

  async uploadDocument(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<Document>("/documents", {
      method: "POST",
      body: formData,
    });
  }

  async getDocument(id: number) {
    return this.request<Document>(`/documents/${id}`);
  }

  async getDocumentProgress(id: number) {
    return this.request<DocumentProgress>(`/documents/${id}/progress`);
  }

  async getDocumentImages(id: number) {
    return this.request<ExtractedImage[]>(`/documents/${id}/images`);
  }

  async deleteDocument(id: number) {
    return this.request<{ message: string }>(`/documents/${id}`, {
      method: "DELETE",
    });
  }

  getDocumentFileUrl(id: number) {
    return `${API_URL}/documents/${id}/file`;
  }

  // Conversations
  async getConversations(documentId: number) {
    return this.request<Conversation[]>(
      `/conversations/document/${documentId}`,
    );
  }

  async createConversation(documentId: number, title?: string) {
    return this.request<Conversation>(`/conversations/document/${documentId}`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  async getMessages(conversationId: number, limit?: number) {
    const query =
      typeof limit === "number" && limit > 0
        ? `?limit=${Math.trunc(limit)}`
        : "";
    return this.request<Message[]>(
      `/conversations/${conversationId}/messages${query}`,
    );
  }

  // Chat
  async sendMessage(conversationId: number, message: string) {
    return this.request<ChatResponse>(`/conversations/${conversationId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }
}

export const api = new ApiClient();

// Types
export interface User {
  id: number;
  email: string;
  name: string;
}

export interface Document {
  id: number;
  user_id: number;
  filename: string;
  original_name: string;
  ai_title_short?: string | null;
  ai_summary?: string | null;
  file_size: number;
  page_count: number;
  status: "processing" | "ready" | "error";
  created_at: string;
}

export interface DocumentsPageResult {
  items: Document[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  query: string;
}

export interface Conversation {
  id: number;
  user_id: number;
  document_id: number;
  title: string;
  created_at: string;
  message_count?: number;
  last_message_at?: string | null;
}

export interface Source {
  chunk_id: number;
  page_number: number;
  start_offset: number;
  end_offset: number;
  snippet: string;
  relevance_score: number;
  image_id?: number;
  image_preview_url?: string;
  image_download_url?: string;
  image_width?: number | null;
  image_height?: number | null;
  image_size?: number | null;
}

export interface ExtractedImage {
  id: number;
  document_id: number;
  page_number: number | null;
  image_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  file_size: number;
  source_type: "embedded" | "page_capture";
  context_text?: string | null;
  created_at: string;
  preview_url: string;
  download_url: string;
}

export interface DocumentProgress {
  document_id: number;
  status: Document["status"];
  stage: string | null;
  status_message: string | null;
  progress_percent: number;
  chunks_total: number;
  chunks_processed: number;
  extracted_image_count: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
  images?: Array<{
    id: number;
    page_number: number | null;
    preview_url?: string;
    download_url: string;
    width: number | null;
    height: number | null;
    file_size: number | null;
  }>;
  created_at: string;
}

export interface ChatResponse {
  userMessage: Message;
  assistantMessage: Message;
}
