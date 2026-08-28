import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "../db/cliente";

/**
 * Isolamento de tenant — barreira 1 de 2.
 *
 * `withTenant(id, fn)` abre uma transação, marca `app.tenant_id` nela (o que
 * ativa as policies de RLS) e disponibiliza um client que injeta `tenantId`
 * em todo where e todo create.
 *
 * Fora de um withTenant, qualquer acesso a modelo com tenant lança. Isso é
 * deliberado: um erro alto e barulhento é muito melhor que uma consulta que
 * silenciosamente devolve os dados de todo mundo.
 */

export class SemContextoDeTenantError extends Error {
  constructor(modelo: string, operacao: string) {
    super(
      `${modelo}.${operacao} foi chamado fora de withTenant(). ` +
        `Todo acesso a dado de negócio precisa de um tenant no contexto.`,
    );
    this.name = "SemContextoDeTenantError";
  }
}

const armazenamento = new AsyncLocalStorage<{ tenantId: string }>();

/** O tenant da chamada corrente, ou undefined fora de withTenant. */
export function tenantAtual(): string | undefined {
  return armazenamento.getStore()?.tenantId;
}

export function exigirTenantAtual(): string {
  const id = tenantAtual();
  if (!id) {
    throw new SemContextoDeTenantError("contexto", "exigirTenantAtual");
  }
  return id;
}

/**
 * Modelos que carregam `tenantId` e por isso entram no escopo automático.
 *
 * `usuario` fica de fora — é global, um usuário pode servir vários tenants.
 * `servicoProfissional` fica de fora — não tem coluna própria; herda o
 * isolamento pelas chaves estrangeiras e pelas policies das tabelas pai.
 * `tenant` fica de fora — é filtrado por `id`, não por `tenantId`.
 */
const MODELOS_COM_TENANT = new Set([
  "Membership",
  "ConfigNegocio",
  "Constituicao",
  "Persona",
  "Marca",
  "Servico",
  "Profissional",
  "EtapaFunil",
  "FerramentaAtiva",
  "Contato",
  "Conversa",
  "Mensagem",
  "Agendamento",
  "TraceAgente",
]);

/** Operações de leitura/escrita que aceitam `where`. */
const OPERACOES_COM_WHERE = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "upsert",
]);

const OPERACOES_COM_DATA = new Set(["create", "createMany", "upsert", "update"]);

type ClientEstendido = ReturnType<typeof estender>;

function estender(cliente: Prisma.TransactionClient, tenantId: string) {
  return (cliente as unknown as PrismaClient).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!MODELOS_COM_TENANT.has(model)) {
            return query(args);
          }

          const a = args as Record<string, unknown>;

          if (OPERACOES_COM_WHERE.has(operation)) {
            a.where = { ...(a.where as object | undefined), tenantId };
          }

          if (OPERACOES_COM_DATA.has(operation)) {
            a.data = injetarTenant(a.data, tenantId);
            // upsert tem os dois caminhos
            if (operation === "upsert") {
              a.create = injetarTenant(a.create, tenantId);
              a.update = injetarTenant(a.update, tenantId);
            }
          }

          return query(a);
        },
      },
    },
  });
}

function injetarTenant(data: unknown, tenantId: string): unknown {
  if (data === undefined || data === null) return data;
  if (Array.isArray(data)) {
    return data.map((d) => ({ ...(d as object), tenantId }));
  }
  return { ...(data as object), tenantId };
}

export interface OpcoesTenant {
  /** Client alternativo — usado pelos testes. */
  cliente?: PrismaClient;
}

/**
 * Roda `fn` no escopo de um tenant.
 *
 * Tudo acontece dentro de uma transação porque `SET LOCAL` é escopado à
 * transação: fora dela o valor vazaria para a próxima consulta que pegasse
 * a mesma conexão do pool — e um tenant leria os dados do outro.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: ClientEstendido) => Promise<T>,
  opcoes: OpcoesTenant = {},
): Promise<T> {
  if (!tenantId) {
    throw new Error("withTenant recebeu um tenantId vazio");
  }

  const base = opcoes.cliente ?? prisma;

  return armazenamento.run({ tenantId }, () =>
    base.$transaction(async (tx) => {
      // Ativa as policies de RLS para esta transação. $executeRawUnsafe é
      // necessário porque SET LOCAL não aceita parâmetro ligado; o valor é
      // um cuid gerado por nós, e o regex abaixo o confirma antes de ir.
      if (!/^[a-z0-9_-]{1,64}$/i.test(tenantId)) {
        throw new Error(`tenantId com formato inesperado: ${tenantId}`);
      }
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);

      return fn(estender(tx, tenantId));
    }),
  );
}
