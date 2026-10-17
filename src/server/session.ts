import { createHash, randomBytes } from "node:crypto";
import sign from "cookie-signature";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { env } from "./env.js";

const COOKIE = "zyntra_session";

export interface SessionUser {
  id: string;
  discordId: string;
  username: string;
  avatar: string | null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function loadDb() {
  const { getDb } = await import("../db/client.js");
  const schema = await import("../db/schema.js");
  return { db: getDb(), schema };
}

/** Crea sesión persistida en Postgres (revocable). Retorna token firmado. */
export async function createSession(user: SessionUser): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const hash = tokenHash(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  try {
    const { db, schema } = await loadDb();
    const { eq } = await import("drizzle-orm");
    const found = await db.select().from(schema.users).where(eq(schema.users.discordId, user.discordId)).limit(1);
    let userId = found[0]?.id as string | undefined;
    if (!userId) {
      const ins = await db.insert(schema.users).values({
        discordId: user.discordId,
        username: user.username,
        avatar: user.avatar,
        isAdmin: true,
        lastLoginAt: new Date(),
      } as never).returning({ id: schema.users.id });
      userId = ins[0].id;
    } else {
      await db.update(schema.users).set({ username: user.username, avatar: user.avatar, lastLoginAt: new Date() } as never).where(eq(schema.users.discordId, user.discordId));
    }
    await db.insert(schema.sessions).values({ userId, tokenHash: hash, expiresAt } as never);
  } catch {
    /* sin DB: sesión stateless firmada */
  }
  return sign.sign(Buffer.from(JSON.stringify({ ...user, token: hash })).toString("base64"), env.SESSION_SECRET);
}

export async function getSessionUser(c: Context): Promise<SessionUser | null> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  const unsigned = sign.unsign(raw, env.SESSION_SECRET);
  if (!unsigned) return null;
  try {
    const data = JSON.parse(Buffer.from(unsigned, "base64").toString());
    // Si hay DB, verificar que la sesión no fue revocada/expirada.
    try {
      const { db, schema } = await loadDb();
      const { eq, and, gt } = await import("drizzle-orm");
      const rows = await db.select().from(schema.sessions).where(
        and(eq(schema.sessions.tokenHash, data.token), gt(schema.sessions.expiresAt, new Date())),
      ).limit(1);
      if (rows.length === 0 && data.token) {
        // Sesión stateless (DB no disponible al crearla) → aceptar si el usuario es admin allowlist.
        const { isAdmin } = await import("./env.js");
        if (!isAdmin(data.discordId)) return null;
      }
    } catch {
      /* DB no disponible: confía en firma */
    }
    return data as SessionUser;
  } catch {
    return null;
  }
}

export function setSessionCookie(c: Context, signed: string) {
  setCookie(c, COOKIE, signed, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
}

export async function destroySession(c: Context) {
  const user = await getSessionUser(c);
  if (user && (user as unknown as Record<string, string>).token) {
    try {
      const { db, schema } = await loadDb();
      const { eq } = await import("drizzle-orm");
      await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, (user as unknown as Record<string, string>).token));
    } catch {
      /* noop */
    }
  }
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function requireAdmin(c: Context, next: Next) {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { isAdmin } = await import("./env.js");
  if (!isAdmin(user.discordId)) return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  await next();
}
