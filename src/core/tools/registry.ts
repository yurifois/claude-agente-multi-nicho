import { z } from "zod";

import type { DefinicaoFerramenta } from "../providers/llm/tipos";
import type {
  ContextoFerramenta,
  FerramentaQualquer,
  ResultadoFerramenta,
} from "./tipos";

/**
 * Registry de ferramentas por tenant.
 *
 * O ponto central: o registry só entrega as ferramentas **ligadas** para
 * aquele tenant. É esse filtro que faz um escritório de advocacia não ver
 * `criar_agendamento` — sem `if (nicho === "advocacia")` em lugar nenhum.
 *
 * O modelo não sabe que existem ferramentas desligadas. Ele não pode chamar
 * o que não enxerga.
 */
export class RegistryFerramentas {
  private readonly porNome = new Map<string, FerramentaQualquer>();

  constructor(ferramentas: FerramentaQualquer[] = []) {
    for (const f of ferramentas) this.registrar(f);
  }

  registrar(ferramenta: FerramentaQualquer): this {
    if (this.porNome.has(ferramenta.nome)) {
      throw new Error(`ferramenta duplicada no registry: ${ferramenta.nome}`);
    }
    this.porNome.set(ferramenta.nome, ferramenta);
    return this;
  }

  /** Subconjunto ligado para um tenant, em ordem estável. */
  paraTenant(nomesAtivos: Iterable<string>): RegistryFerramentas {
    const ativos = new Set(nomesAtivos);
    const selecionadas = [...this.porNome.values()]
      .filter((f) => ativos.has(f.nome))
      // Ordem estável importa: o prompt cache é casamento de prefixo, e as
      // ferramentas são renderizadas antes do system. Ordem instável = cache
      // invalidado a cada requisição.
      .sort((a, b) => a.nome.localeCompare(b.nome));

    return new RegistryFerramentas(selecionadas);
  }

  get nomes(): string[] {
    return [...this.porNome.keys()];
  }

  get tamanho(): number {
    return this.porNome.size;
  }

  tem(nome: string): boolean {
    return this.porNome.has(nome);
  }

  /** Definições no formato que o LLMProvider espera. */
  definicoes(): DefinicaoFerramenta[] {
    return [...this.porNome.values()].map((f) => ({
      nome: f.nome,
      descricao: f.descricao,
      schema: paraJsonSchema(f.schema),
    }));
  }

  /**
   * Executa uma chamada do modelo.
   *
   * Argumento inválido não derruba o turno: volta como resultado de erro para
   * o modelo, que quase sempre corrige sozinho na próxima iteração. Derrubar
   * seria pior — o cliente ficaria sem resposta por um campo faltando.
   */
  async executar(
    nome: string,
    argumentos: unknown,
    ctx: ContextoFerramenta,
  ): Promise<ResultadoFerramenta> {
    const ferramenta = this.porNome.get(nome);
    if (!ferramenta) {
      return {
        conteudo: `A ferramenta "${nome}" não existe. Disponíveis: ${this.nomes.join(", ")}.`,
        erro: true,
      };
    }

    const validado = ferramenta.schema.safeParse(argumentos ?? {});
    if (!validado.success) {
      return {
        conteudo:
          `Argumentos inválidos para ${nome}: ` +
          validado.error.issues
            .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
            .join("; "),
        erro: true,
      };
    }

    try {
      return await ferramenta.executar(validado.data, ctx);
    } catch (erro) {
      return {
        conteudo: `Falha ao executar ${nome}: ${
          erro instanceof Error ? erro.message : "erro desconhecido"
        }`,
        erro: true,
      };
    }
  }
}

function paraJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const gerado = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  // A API exige um objeto no topo, mesmo para ferramenta sem argumento.
  if (gerado.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return gerado;
}
