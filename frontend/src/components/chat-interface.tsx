"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ChatMessage } from "./chat-message";
import { api, type Message, type Source, type Conversation } from "@/lib/api";

interface ChatInterfaceProps {
  documentId: number;
  onSourceClick?: (source: Source) => void;
}

const MESSAGE_WINDOW_SIZE = 10;
const CHAT_DROPDOWN_LIMIT = 5;

export function ChatInterface({
  documentId,
  onSourceClick,
}: ChatInterfaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const conversationStorageKey = `pdf-qa-active-conversation-${documentId}`;
  const recentConversations = conversations.slice(0, CHAT_DROPDOWN_LIMIT);
  const activeConversationId =
    activeConversation?.id ?? recentConversations[0]?.id ?? "";

  // Load conversations
  useEffect(() => {
    let cancelled = false;

    setConversations([]);
    setActiveConversation(null);
    setMessages([]);
    setConversationsLoaded(false);

    api
      .getConversations(documentId)
      .then((data) => {
        if (!cancelled) {
          setConversations(data);
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) {
          setConversationsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Resolve active conversation after conversations are loaded.
  useEffect(() => {
    if (!conversationsLoaded) {
      return;
    }

    if (conversations.length === 0) {
      api
        .createConversation(documentId, "Chat")
        .then((conv) => {
          setConversations([conv]);
          setActiveConversation(conv);
          localStorage.setItem(conversationStorageKey, String(conv.id));
        })
        .catch(console.error);
      return;
    }

    if (!activeConversation) {
      const savedConversationId = Number(
        localStorage.getItem(conversationStorageKey),
      );
      const savedConversation = conversations.find(
        (c) => c.id === savedConversationId,
      );

      const conversationWithHistory = conversations.find(
        (c) => (c.message_count || 0) > 0,
      );

      setActiveConversation(
        savedConversation || conversationWithHistory || conversations[0],
      );
      return;
    }

    const stillExists = conversations.some(
      (c) => c.id === activeConversation.id,
    );
    if (!stillExists) {
      setActiveConversation(conversations[0]);
    }
  }, [
    conversations,
    documentId,
    activeConversation,
    conversationsLoaded,
    conversationStorageKey,
  ]);

  // Persist active conversation per document.
  useEffect(() => {
    if (activeConversation) {
      localStorage.setItem(
        conversationStorageKey,
        String(activeConversation.id),
      );
    }
  }, [activeConversation, conversationStorageKey]);

  // Load messages when conversation changes
  useEffect(() => {
    if (activeConversation) {
      api
        .getMessages(activeConversation.id, MESSAGE_WINDOW_SIZE)
        .then(setMessages)
        .catch(console.error);
    }
  }, [activeConversation]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || !activeConversation || sending) return;

    const userMessage = input.trim();
    setInput("");
    setSending(true);

    // Optimistically add user message
    const tempUserMsg: Message = {
      id: Date.now(),
      conversation_id: activeConversation.id,
      role: "user",
      content: userMessage,
      sources: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const response = await api.sendMessage(
        activeConversation.id,
        userMessage,
      );
      // Replace temp message with actual and add assistant response
      setMessages((prev) =>
        [
          ...prev.slice(0, -1),
          response.userMessage,
          response.assistantMessage,
        ].slice(-MESSAGE_WINDOW_SIZE),
      );

      // Refresh conversation metadata so dropdown order reflects latest activity.
      api
        .getConversations(documentId)
        .then(setConversations)
        .catch(console.error);
    } catch (err) {
      // Add error message
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          conversation_id: activeConversation.id,
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
          sources: null,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function handleNewConversation() {
    try {
      const conv = await api.createConversation(documentId, "Chat");
      setConversations((prev) => [conv, ...prev]);
      setActiveConversation(conv);
      setMessages([]);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="font-medium text-sm">Chat</h3>
          <select
            aria-label="Recent chats"
            className="h-8 rounded-md border border-border bg-background px-2 text-xs max-w-[210px]"
            value={activeConversationId}
            onChange={(e) => {
              const selectedId = Number(e.target.value);
              const selected = conversations.find((c) => c.id === selectedId);
              if (selected) {
                setActiveConversation(selected);
              }
            }}
            disabled={recentConversations.length === 0}
          >
            {recentConversations.map((conv, index) => {
              const when = conv.last_message_at || conv.created_at;
              const label = `${index + 1}. ${new Date(when).toLocaleString()}`;
              return (
                <option key={conv.id} value={conv.id}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
        <Button variant="ghost" size="sm" onClick={handleNewConversation}>
          <Plus className="h-4 w-4 mr-1" />
          Chat
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-8">
            Ask a question about this document
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            onSourceClick={onSourceClick}
          />
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this document..."
            disabled={sending}
            className="flex-1"
          />
          <Button type="submit" size="icon" disabled={sending || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
