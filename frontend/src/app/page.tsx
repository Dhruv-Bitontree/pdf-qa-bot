"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AuthForm } from "@/components/auth-form";

export default function HomePage() {
  const { user, login, register, loading } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const router = useRouter();

  // Redirect to dashboard if already logged in
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (user) {
    router.push("/dashboard");
    return null;
  }

  async function handleSubmit(data: { email: string; password: string; name?: string }) {
    if (mode === "login") {
      await login(data.email, data.password);
    } else {
      await register(data.email, data.password, data.name!);
    }
    router.push("/dashboard");
  }

  return (
    <AuthForm
      mode={mode}
      onSubmit={handleSubmit}
      onToggleMode={() => setMode((m) => (m === "login" ? "register" : "login"))}
    />
  );
}
