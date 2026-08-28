import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Conexões do sistema.
 *
 * Duas, de propósito, com credenciais diferentes:
 *
 *   `prisma`      — role `agente_app`. Sujeita a Row-Level Security. É a que
 *                   todo código de negócio usa, sempre dentro de withTenant().
 *   `prismaAdmin` — role `agente_admin`, com BYPASSRLS. Só as rotas de
 *                   administração da plataforma e o seed.
 *
 * Se as duas fossem a mesma, a barreira do banco seria decorativa.
 */

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __prismaAdmin: PrismaClient | undefined;
}

function criar(url: string | undefined, nome: string): PrismaClient {
  if (!url) {
    throw new Error(
      `${nome} não está definida. Copie .env.example para .env e preencha.`,
    );
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

/** Conexão da aplicação. Sujeita a RLS — use sempre via withTenant(). */
export const prisma: PrismaClient =
  globalThis.__prisma ?? criar(process.env.DATABASE_URL, "DATABASE_URL");

/** Conexão de super-admin. Ignora RLS. Use com parcimônia. */
export const prismaAdmin: PrismaClient =
  globalThis.__prismaAdmin ??
  criar(
    process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
    "DATABASE_ADMIN_URL",
  );

// O hot reload do Next recria módulos a cada edição; sem isto o pool de
// conexões cresce até o Postgres recusar novas.
if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
  globalThis.__prismaAdmin = prismaAdmin;
}
