const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

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
    return this.request<Conversation[]>(`/conversations/document/${documentId}`);
  }

  async createConversation(documentId: number, title?: string) {
    return this.request<Conversation>(`/conversations/document/${documentId}`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  async getMessages(conversationId: number) {
    return this.request<Message[]>(`/conversations/${conversationId}/messages`);
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
  file_size: number;
  page_count: number;
  status: "processing" | "ready" | "error";
  created_at: string;
}

export interface Conversation {
  id: number;
  user_id: number;
  document_id: number;
  title: string;
  created_at: string;
}

export interface Source {
  chunk_id: number;
  page_number: number;
  start_offset: number;
  end_offset: number;
  snippet: string;
  relevance_score: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
  created_at: string;
}

export interface ChatResponse {
  userMessage: Message;
  assistantMessage: Message;
}
