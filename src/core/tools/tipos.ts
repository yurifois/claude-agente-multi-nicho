import type { z } from "zod";

/**
 * Ferramentas — o terceiro pilar.
 *
 * Sem ferramentas não é agente: é um modelo redigindo texto. É a chamada de
 * ferramenta que faz o modelo escolher um caminho em vez de seguir um trilho.
 */

/** O que a ferramenta pode ler e mexer quando executa. */
export interface ContextoFerramenta {
  tenantId: string;
  conversaId: string;
  contatoId: string;
  /** Agora, em UTC. Injetado para os testes serem determinísticos. */
  agora: Date;
  /** IANA, ex.: America/Sao_Paulo */
  fuso: string;
}

export interface ResultadoFerramenta {
  /** Texto que volta para o modelo. Escreva para o modelo ler, não para log. */
  conteudo: string;
  erro?: boolean;
  /** Efeitos que o loop precisa conhecer — p.ex. pausar a conversa. */
  efeitos?: EfeitosFerramenta;
}

export interface EfeitosFerramenta {
  /** `escalar_humano` pede que o agente pare de responder esta conversa. */
  pausarConversa?: boolean;
  /** Preços legítimos criados neste turno, para o guardrail não barrar. */
  precosAutorizados?: number[];
}

export interface Ferramenta<TSchema extends z.ZodType = z.ZodType> {
  nome: string;
  /**
   * É por esta descrição que o modelo decide quando usar a ferramenta.
   * Vaga aqui significa ferramenta errada lá. Diga o que ela faz e quando
   * usar, não como foi implementada.
   */
  descricao: string;
  schema: TSchema;
  executar(
    args: z.infer<TSchema>,
    ctx: ContextoFerramenta,
  ): Promise<ResultadoFerramenta>;
}

/** Ferramenta com o tipo do schema apagado, para guardar em coleção. */
export type FerramentaQualquer = Ferramenta<z.ZodType>;
