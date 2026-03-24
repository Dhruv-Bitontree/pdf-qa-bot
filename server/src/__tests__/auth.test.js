import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";
import { createDb } from "../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Auth API", () => {
  let app, db, dbPath;

  before(async () => {
    dbPath = path.join(__dirname, `test-auth-${Date.now()}.db`);
    db = await createDb(dbPath);
    app = createApp(db);
  });

  after(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("should register a new user", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      });

    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, "test@example.com");
    assert.equal(res.body.user.name, "Test User");
  });

  it("should reject duplicate email", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      });

    assert.equal(res.status, 409);
    assert.ok(res.body.error.includes("already"));
  });

  it("should reject invalid registration data", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "invalid", password: "12", name: "" });

    assert.equal(res.status, 400);
  });

  it("should login with correct credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, "test@example.com");
  });

  it("should reject wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com", password: "wrongpass" });

    assert.equal(res.status, 401);
  });

  it("should reject non-existent user", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nonexistent@example.com", password: "password123" });

    assert.equal(res.status, 401);
  });
});
