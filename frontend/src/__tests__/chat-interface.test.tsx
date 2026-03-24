import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage } from "@/components/chat-message";
import type { Message } from "@/lib/api";

describe("ChatMessage", () => {
  it("should render user message", () => {
    const msg: Message = {
      id: 1,
      conversation_id: 1,
      role: "user",
      content: "What is machine learning?",
      sources: null,
      created_at: new Date().toISOString(),
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("What is machine learning?")).toBeDefined();
  });

  it("should render assistant message", () => {
    const msg: Message = {
      id: 2,
      conversation_id: 1,
      role: "assistant",
      content: "Machine learning is a branch of AI.",
      sources: null,
      created_at: new Date().toISOString(),
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("Machine learning is a branch of AI.")).toBeDefined();
  });

  it("should render source badges", () => {
    const msg: Message = {
      id: 3,
      conversation_id: 1,
      role: "assistant",
      content: "Here is the answer.",
      sources: [
        {
          chunk_id: 1,
          page_number: 3,
          start_offset: 0,
          end_offset: 100,
          snippet: "Some text from page 3",
          relevance_score: 2.5,
        },
        {
          chunk_id: 2,
          page_number: 7,
          start_offset: 0,
          end_offset: 100,
          snippet: "Some text from page 7",
          relevance_score: 1.8,
        },
      ],
      created_at: new Date().toISOString(),
    };

    render(<ChatMessage message={msg} />);
    expect(screen.getByText("Page 3")).toBeDefined();
    expect(screen.getByText("Page 7")).toBeDefined();
  });

  it("should call onSourceClick when source badge is clicked", () => {
    const onSourceClick = vi.fn();
    const source = {
      chunk_id: 1,
      page_number: 5,
      start_offset: 0,
      end_offset: 100,
      snippet: "text",
      relevance_score: 2.0,
    };

    const msg: Message = {
      id: 4,
      conversation_id: 1,
      role: "assistant",
      content: "Answer",
      sources: [source],
      created_at: new Date().toISOString(),
    };

    render(<ChatMessage message={msg} onSourceClick={onSourceClick} />);
    screen.getByText("Page 5").click();
    expect(onSourceClick).toHaveBeenCalledWith(source);
  });
});
