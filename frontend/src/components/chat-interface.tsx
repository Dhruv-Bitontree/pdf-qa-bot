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

export function ChatInterface({ documentId, onSourceClick }: ChatInterfaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load conversations
  useEffect(() => {
    api.getConversations(documentId).then(setConversations).catch(console.error);
  }, [documentId]);

  // Auto-create conversation if none exist
  useEffect(() => {
    if (conversations.length === 0) {
      api
        .createConversation(documentId, "Chat")
        .then((conv) => {
          setConversations([conv]);
          setActiveConversation(conv);
        })
        .catch(console.error);
    } else if (!activeConversation) {
      setActiveConversation(conversations[0]);
    }
  }, [conversations, documentId, activeConversation]);

  // Load messages when conversation changes
  useEffect(() => {
    if (activeConversation) {
      api.getMessages(activeConversation.id).then(setMessages).catch(console.error);
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
      const response = await api.sendMessage(activeConversation.id, userMessage);
      // Replace temp message with actual and add assistant response
      setMessages((prev) => [
        ...prev.slice(0, -1),
        response.userMessage,
        response.assistantMessage,
      ]);
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
        <h3 className="font-medium text-sm">Chat</h3>
        <Button variant="ghost" size="sm" onClick={handleNewConversation}>
          <Plus className="h-4 w-4 mr-1" />
          New
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
