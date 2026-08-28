import Anthropic from "@anthropic-ai/sdk";

import {
  ErroLLMPermanente,
  ErroLLMTransitorio,
  type BlocoConteudo,
  type LLMProvider,
  type MensagemLLM,
  type MotivoParada,
  type RequisicaoLLM,
  type RespostaLLM,
} from "./tipos";

export interface OpcoesAnthropic {
  apiKey?: string;
  modelo?: string;
}

/**
 * Driver Claude.
 *
 * Duas decisões que valem explicação:
 *
 * 1. O bloco de sistema leva `cache_control` no fim. A constituição de um
 *    tenant tem alguns milhares de tokens e é idêntica em toda mensagem —
 *    é exatamente o caso que o prompt cache existe para resolver.
 *
 * 2. `mensagem.bruto` é reenviado quando existe. Modelos com raciocínio
 *    adaptativo devolvem blocos de pensamento que precisam voltar intactos
 *    dentro do mesmo turno; reserializar a partir da nossa normalização os
 *    perderia.
 */
export class ProviderAnthropic implements LLMProvider {
  readonly nome = "anthropic";
  readonly modelo: string;
  private readonly cliente: Anthropic;

  constructor(opcoes: OpcoesAnthropic = {}) {
    const apiKey = opcoes.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ErroLLMPermanente(
        "ANTHROPIC_API_KEY não está definida",
        "anthropic",
      );
    }
    this.cliente = new Anthropic({ apiKey });
    this.modelo = opcoes.modelo ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
  }

  async completar(req: RequisicaoLLM): Promise<RespostaLLM> {
    const inicio = Date.now();

    try {
      const resposta = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: req.maxTokens ?? 2000,
        system: [
          {
            type: "text",
            text: req.sistema,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: req.mensagens.map(paraMensagemAnthropic),
        tools: req.ferramentas.map((f) => ({
          name: f.nome,
          description: f.descricao,
          input_schema: f.schema as Anthropic.Tool["input_schema"],
        })),
        thinking: { type: "adaptive" },
        output_config: { effort: req.esforco ?? "low" },
      });

      return normalizarResposta(resposta, this.modelo, Date.now() - inicio);
    } catch (erro) {
      throw traduzirErro(erro);
    }
  }
}

function paraMensagemAnthropic(m: MensagemLLM): Anthropic.MessageParam {
  // Turno do assistente que já veio da API: devolve intacto para preservar
  // blocos de raciocínio.
  if (m.papel === "assistant" && m.bruto) {
    return { role: "assistant", content: m.bruto as Anthropic.ContentBlockParam[] };
  }

  return {
    role: m.papel,
    content: m.blocos.map((b): Anthropic.ContentBlockParam => {
      switch (b.tipo) {
        case "texto":
          return { type: "text", text: b.texto };
        case "chamada_ferramenta":
          return {
            type: "tool_use",
            id: b.id,
            name: b.nome,
            input: b.argumentos,
          };
        case "resultado_ferramenta":
          return {
            type: "tool_result",
            tool_use_id: b.id,
            content: b.conteudo,
            ...(b.erro ? { is_error: true } : {}),
          };
      }
    }),
  };
}

function normalizarResposta(
  resposta: Anthropic.Message,
  modelo: string,
  latenciaMs: number,
): RespostaLLM {
  const partesTexto: string[] = [];
  const chamadas: RespostaLLM["chamadas"] = [];

  for (const bloco of resposta.content) {
    if (bloco.type === "text") {
      partesTexto.push(bloco.text);
    } else if (bloco.type === "tool_use") {
      chamadas.push({
        id: bloco.id,
        nome: bloco.name,
        // O input já vem desserializado pelo SDK. Nunca casar string crua
        // sobre ele: o escape de JSON varia entre modelos.
        argumentos: (bloco.input ?? {}) as Record<string, unknown>,
      });
    }
    // Blocos de raciocínio ficam preservados em `bruto`.
  }

  return {
    texto: partesTexto.join("\n").trim(),
    chamadas,
    motivoParada: traduzirMotivoParada(resposta.stop_reason),
    uso: {
      entrada: resposta.usage.input_tokens,
      saida: resposta.usage.output_tokens,
      cacheLeitura: resposta.usage.cache_read_input_tokens ?? 0,
      cacheEscrita: resposta.usage.cache_creation_input_tokens ?? 0,
    },
    modelo,
    bruto: resposta.content,
    latenciaMs,
  };
}

function traduzirMotivoParada(motivo: string | null): MotivoParada {
  switch (motivo) {
    case "tool_use":
      return "ferramenta";
    case "max_tokens":
      return "limite_tokens";
    case "refusal":
      return "recusa";
    case "pause_turn":
      return "pausa";
    default:
      return "fim";
  }
}

/**
 * Separa o que vale retentar do que não vale.
 *
 * Retentar um 400 é desperdício: a requisição está malformada e vai falhar
 * de novo. Retentar um 429 ou 5xx costuma resolver.
 */
function traduzirErro(erro: unknown): Error {
  if (erro instanceof Anthropic.RateLimitError) {
    return new ErroLLMTransitorio("limite de taxa da Anthropic", "anthropic", erro);
  }
  if (erro instanceof Anthropic.APIConnectionError) {
    return new ErroLLMTransitorio("falha de conexão com a Anthropic", "anthropic", erro);
  }
  if (erro instanceof Anthropic.AuthenticationError) {
    return new ErroLLMPermanente("chave da Anthropic inválida", "anthropic", erro);
  }
  if (erro instanceof Anthropic.BadRequestError) {
    return new ErroLLMPermanente(
      `requisição inválida para a Anthropic: ${erro.message}`,
      "anthropic",
      erro,
    );
  }
  if (erro instanceof Anthropic.APIError) {
    const transitorio = erro.status === undefined || erro.status >= 500;
    const Classe = transitorio ? ErroLLMTransitorio : ErroLLMPermanente;
    return new Classe(`erro ${erro.status} da Anthropic: ${erro.message}`, "anthropic", erro);
  }
  return new ErroLLMTransitorio(
    erro instanceof Error ? erro.message : "erro desconhecido",
    "anthropic",
    erro,
  );
}

export type { BlocoConteudo };
