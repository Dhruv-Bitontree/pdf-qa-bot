"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { User, Bot, Download, Image as ImageIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { api } from "@/lib/api";
import type { Message, Source } from "@/lib/api";

interface ChatMessageProps {
  message: Message;
  onSourceClick?: (source: Source) => void;
}

export function ChatMessage({ message, onSourceClick }: ChatMessageProps) {
  const isUser = message.role === "user";
  const uniqueSources =
    message.sources?.filter(
      (source, index, arr) =>
        arr.findIndex((s) => s.page_number === source.page_number) === index,
    ) || [];
  const displayImages = message.images || [];

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
        className={`max-w-[88%] sm:max-w-[80%] rounded-lg px-3 sm:px-4 py-3 ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        <MarkdownMessage content={message.content} />

        {!isUser && displayImages.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border/30 space-y-2">
            <p className="text-xs text-muted-foreground">Detected images</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {displayImages.map((img) => (
                <div
                  key={img.id}
                  className="rounded-md border border-border/60 bg-background/80 p-2 overflow-hidden"
                >
                  <ImagePreview image={img} />
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs">
                    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span className="truncate">
                        {img.page_number
                          ? `Page ${img.page_number}`
                          : `Image ${img.id}`}
                      </span>
                    </span>
                    <a
                      href="#"
                      className="inline-flex w-fit items-center gap-1 text-primary hover:underline"
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          const label = img.page_number
                            ? `page-${img.page_number}`
                            : `image-${img.id}`;
                          await api.downloadAuthenticatedFile(
                            img.download_url,
                            `${label}.png`,
                          );
                        } catch (err) {
                          console.error(err);
                        }
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </a>
                  </div>
                  {(img.width || img.height || img.file_size) && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {img.width && img.height
                        ? `${img.width}x${img.height}`
                        : "PNG"}
                      {img.file_size
                        ? ` • ${Math.max(1, Math.round(img.file_size / 1024))} KB`
                        : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Source references */}
        {uniqueSources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border/30">
            {uniqueSources.map((source, i) => (
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

function MarkdownMessage({ content }: { content: string }) {
  const lines = String(content || "").split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let bulletBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    nodes.push(
      <ul
        key={`ul-${nodes.length}`}
        className="list-disc pl-5 space-y-1 text-sm"
      >
        {bulletBuffer.map((item, idx) => (
          <li key={idx}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    bulletBuffer = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushBullets();
      return;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      bulletBuffer.push(bulletMatch[1]);
      return;
    }

    flushBullets();

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      nodes.push(
        <p key={`h-${index}`} className="text-sm font-semibold">
          {renderInlineMarkdown(headingMatch[2])}
        </p>,
      );
      return;
    }

    nodes.push(
      <p key={`p-${index}`} className="text-sm leading-relaxed">
        {renderInlineMarkdown(trimmed)}
      </p>,
    );
  });

  flushBullets();
  return <div className="space-y-2 break-words">{nodes}</div>;
}

function renderInlineMarkdown(text: string) {
  const chunks = text.split(/(\*\*[^*]+\*\*)/g);
  return chunks.map((chunk, idx) => {
    if (/^\*\*[^*]+\*\*$/.test(chunk)) {
      return <strong key={idx}>{chunk.slice(2, -2)}</strong>;
    }
    return <Fragment key={idx}>{chunk}</Fragment>;
  });
}

function ImagePreview({
  image,
}: {
  image: {
    id: number;
    preview_url?: string;
    download_url: string;
  };
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let localUrl: string | null = null;

    api
      .fetchAuthenticatedBlobUrl(image.preview_url || image.download_url)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        localUrl = url;
        setBlobUrl(url);
      })
      .catch((err) => {
        console.error(err);
      });

    return () => {
      active = false;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [image.preview_url, image.download_url]);

  if (!blobUrl) {
    return (
      <div className="mb-2 aspect-[4/3] w-full rounded border border-border/40 bg-muted/30 animate-pulse" />
    );
  }

  return (
    <div className="mb-2 aspect-[4/3] w-full overflow-hidden rounded border border-border/40 bg-muted/10">
      <img
        src={blobUrl}
        alt="Detected PDF visual"
        className="h-full w-full object-contain"
      />
    </div>
  );
}
