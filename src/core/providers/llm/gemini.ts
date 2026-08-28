import { GoogleGenAI, type Content, type Part } from "@google/genai";

import {
  ErroLLMPermanente,
  ErroLLMTransitorio,
  type LLMProvider,
  type MensagemLLM,
  type MotivoParada,
  type RequisicaoLLM,
  type RespostaLLM,
} from "./tipos";

export interface OpcoesGemini {
  apiKey?: string;
  modelo?: string;
}

/**
 * Driver Gemini — o provider alternativo.
 *
 * Duas diferenças em relação ao Claude que a normalização precisa absorver:
 *
 * 1. O papel do assistente é `"model"`, não `"assistant"`.
 * 2. Chamadas de função não carregam id obrigatório. O resultado casa pelo
 *    NOME da função, não por id. Como a nossa interface é baseada em id,
 *    sintetizamos um e mantemos o mapa nome→id dentro do turno.
 */
export class ProviderGemini implements LLMProvider {
  readonly nome = "gemini";
  readonly modelo: string;
  private readonly cliente: GoogleGenAI;

  constructor(opcoes: OpcoesGemini = {}) {
    const apiKey = opcoes.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ErroLLMPermanente("GEMINI_API_KEY não está definida", "gemini");
    }
    this.cliente = new GoogleGenAI({ apiKey });
    this.modelo = opcoes.modelo ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  }

  async completar(req: RequisicaoLLM): Promise<RespostaLLM> {
    const inicio = Date.now();

    try {
      const resposta = await this.cliente.models.generateContent({
        model: this.modelo,
        contents: req.mensagens.map(paraContentGemini),
        config: {
          systemInstruction: req.sistema,
          maxOutputTokens: req.maxTokens ?? 2000,
          ...(req.ferramentas.length > 0
            ? {
                tools: [
                  {
                    functionDeclarations: req.ferramentas.map((f) => ({
                      name: f.nome,
                      description: f.descricao,
                      parametersJsonSchema: f.schema,
                    })),
                  },
                ],
              }
            : {}),
        },
      });

      const partes = resposta.candidates?.[0]?.content?.parts ?? [];
      const textos: string[] = [];
      const chamadas: RespostaLLM["chamadas"] = [];

      for (const parte of partes) {
        if (typeof parte.text === "string" && parte.text.length > 0) {
          textos.push(parte.text);
        }
        if (parte.functionCall?.name) {
          chamadas.push({
            // O Gemini pode omitir o id; o nome é o que amarra o resultado.
            id: parte.functionCall.id ?? `gemini_${parte.functionCall.name}`,
            nome: parte.functionCall.name,
            argumentos: (parte.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }

      const uso = resposta.usageMetadata;
      const motivo = resposta.candidates?.[0]?.finishReason;

      return {
        texto: textos.join("\n").trim(),
        chamadas,
        motivoParada:
          chamadas.length > 0 ? "ferramenta" : traduzirMotivoParada(motivo),
        uso: {
          entrada: uso?.promptTokenCount ?? 0,
          saida: uso?.candidatesTokenCount ?? 0,
          cacheLeitura: uso?.cachedContentTokenCount ?? 0,
          cacheEscrita: 0,
        },
        modelo: this.modelo,
        bruto: partes,
        latenciaMs: Date.now() - inicio,
      };
    } catch (erro) {
      throw traduzirErro(erro);
    }
  }
}

function paraContentGemini(m: MensagemLLM): Content {
  if (m.papel === "assistant" && m.bruto) {
    return { role: "model", parts: m.bruto as Part[] };
  }

  const parts: Part[] = [];
  for (const b of m.blocos) {
    switch (b.tipo) {
      case "texto":
        parts.push({ text: b.texto });
        break;
      case "chamada_ferramenta":
        parts.push({ functionCall: { name: b.nome, args: b.argumentos } });
        break;
      case "resultado_ferramenta":
        // O Gemini casa o resultado pelo nome da função, não por id.
        parts.push({
          functionResponse: {
            name: b.nome,
            response: b.erro
              ? { error: b.conteudo }
              : { resultado: b.conteudo },
          },
        });
        break;
    }
  }

  return { role: m.papel === "assistant" ? "model" : "user", parts };
}

function traduzirMotivoParada(motivo: string | undefined): MotivoParada {
  switch (motivo) {
    case "MAX_TOKENS":
      return "limite_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "recusa";
    default:
      return "fim";
  }
}

function traduzirErro(erro: unknown): Error {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  const status = extrairStatus(erro);

  if (status === 401 || status === 403) {
    return new ErroLLMPermanente(`credencial do Gemini rejeitada: ${mensagem}`, "gemini", erro);
  }
  if (status === 400) {
    return new ErroLLMPermanente(`requisição inválida para o Gemini: ${mensagem}`, "gemini", erro);
  }
  if (status === 429 || status === undefined || status >= 500) {
    return new ErroLLMTransitorio(`falha transitória do Gemini: ${mensagem}`, "gemini", erro);
  }
  return new ErroLLMPermanente(`erro ${status} do Gemini: ${mensagem}`, "gemini", erro);
}

function extrairStatus(erro: unknown): number | undefined {
  if (typeof erro === "object" && erro !== null) {
    const candidato = erro as { status?: unknown; code?: unknown };
    if (typeof candidato.status === "number") return candidato.status;
    if (typeof candidato.code === "number") return candidato.code;
  }
  return undefined;
}
