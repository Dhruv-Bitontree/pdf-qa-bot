"use client";

import { User, Bot } from "lucide-react";
import { Badge } from "./ui/badge";
import type { Message, Source } from "@/lib/api";

interface ChatMessageProps {
  message: Message;
  onSourceClick?: (source: Source) => void;
}

export function ChatMessage({ message, onSourceClick }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
      >
        <div className="text-sm whitespace-pre-wrap break-words">{message.content}</div>

        {/* Source references */}
        {message.sources && message.sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border/30">
            {message.sources.map((source, i) => (
              <Badge
                key={i}
                variant="outline"
                className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors text-xs"
                onClick={() => onSourceClick?.(source)}
              >
                Page {source.page_number}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
