"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api, type User } from "./api";

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem("pdf-qa-token");
    const savedUser = localStorage.getItem("pdf-qa-user");
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
      api.setToken(savedToken);
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setUser(result.user);
    setToken(result.token);
    api.setToken(result.token);
    localStorage.setItem("pdf-qa-token", result.token);
    localStorage.setItem("pdf-qa-user", JSON.stringify(result.user));
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    const result = await api.register(email, password, name);
    setUser(result.user);
    setToken(result.token);
    api.setToken(result.token);
    localStorage.setItem("pdf-qa-token", result.token);
    localStorage.setItem("pdf-qa-user", JSON.stringify(result.user));
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    api.setToken(null);
    localStorage.removeItem("pdf-qa-token");
    localStorage.removeItem("pdf-qa-user");
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
