import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ChatMessage } from "@/components/chat-message";
import type { Message } from "@/lib/api";

describe("Badge", () => {
  it("renders with default variant", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders with success variant", () => {
    const { container } = render(<Badge variant="success">Ready</Badge>);
    expect(container.firstChild).toHaveClass("bg-green-100");
  });

  it("renders with destructive variant", () => {
    const { container } = render(<Badge variant="destructive">Error</Badge>);
    expect(container.firstChild).toHaveClass("bg-red-100");
  });

  it("renders with warning variant", () => {
    const { container } = render(<Badge variant="warning">Processing</Badge>);
    expect(container.firstChild).toHaveClass("bg-yellow-100");
  });
});

describe("Button", () => {
  it("renders and handles click", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    fireEvent.click(screen.getByText("Click me"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled when disabled prop is set", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders with outline variant", () => {
    const { container } = render(<Button variant="outline">Outline</Button>);
    expect(container.firstChild).toHaveClass("border");
  });

  it("renders with ghost variant", () => {
    const { container } = render(<Button variant="ghost">Ghost</Button>);
    expect(container.firstChild).toHaveClass("hover:bg-muted");
  });
});

describe("Input", () => {
  it("renders with placeholder", () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText("Enter text")).toBeInTheDocument();
  });

  it("fires onChange event", () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "test" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});

describe("Card", () => {
  it("renders card with content", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Test Title</CardTitle>
        </CardHeader>
        <CardContent>Content here</CardContent>
      </Card>
    );
    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByText("Content here")).toBeInTheDocument();
  });
});

describe("ChatMessage", () => {
  const userMessage: Message = {
    id: 1,
    conversation_id: 1,
    role: "user",
    content: "What is this document about?",
    sources: null,
    created_at: "2024-01-01T00:00:00Z",
  };

  const assistantMessage: Message = {
    id: 2,
    conversation_id: 1,
    role: "assistant",
    content: "This document covers machine learning topics.",
    sources: [
      {
        chunk_id: 1,
        page_number: 3,
        start_offset: 0,
        end_offset: 100,
        snippet: "Machine learning is...",
        relevance_score: 0.95,
      },
    ],
    created_at: "2024-01-01T00:00:01Z",
  };

  it("renders user message content", () => {
    render(<ChatMessage message={userMessage} />);
    expect(screen.getByText("What is this document about?")).toBeInTheDocument();
  });

  it("renders assistant message content", () => {
    render(<ChatMessage message={assistantMessage} />);
    expect(screen.getByText("This document covers machine learning topics.")).toBeInTheDocument();
  });

  it("renders source page badges for assistant messages", () => {
    render(<ChatMessage message={assistantMessage} />);
    expect(screen.getByText("Page 3")).toBeInTheDocument();
  });

  it("calls onSourceClick when page badge is clicked", () => {
    const onSourceClick = vi.fn();
    render(<ChatMessage message={assistantMessage} onSourceClick={onSourceClick} />);
    fireEvent.click(screen.getByText("Page 3"));
    expect(onSourceClick).toHaveBeenCalledWith(assistantMessage.sources![0]);
  });

  it("does not render sources for user messages", () => {
    render(<ChatMessage message={userMessage} />);
    expect(screen.queryByText(/Page \d+/)).not.toBeInTheDocument();
  });
});
