import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AuthForm } from "@/components/auth-form";

describe("AuthForm", () => {
  it("should render login form", () => {
    render(
      <AuthForm mode="login" onSubmit={vi.fn()} onToggleMode={vi.fn()} />
    );

    expect(screen.getByRole("heading", { name: "Sign In" })).toBeDefined();
    expect(screen.getByPlaceholderText("you@example.com")).toBeDefined();
    expect(screen.getByPlaceholderText("••••••••")).toBeDefined();
  });

  it("should render register form with name field", () => {
    render(
      <AuthForm mode="register" onSubmit={vi.fn()} onToggleMode={vi.fn()} />
    );

    expect(screen.getByRole("heading", { name: "Create Account" })).toBeDefined();
    expect(screen.getByPlaceholderText("Your name")).toBeDefined();
  });

  it("should call onSubmit with form data", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthForm mode="login" onSubmit={onSubmit} onToggleMode={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "test@test.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: "test@test.com",
        password: "password123",
      });
    });
  });

  it("should display error on failed submit", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Bad credentials"));

    render(
      <AuthForm mode="login" onSubmit={onSubmit} onToggleMode={vi.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "test@test.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Bad credentials");
    });
  });

  it("should toggle between login and register", () => {
    const onToggle = vi.fn();
    render(
      <AuthForm mode="login" onSubmit={vi.fn()} onToggleMode={onToggle} />
    );

    fireEvent.click(screen.getByText("Sign up"));
    expect(onToggle).toHaveBeenCalled();
  });
});
