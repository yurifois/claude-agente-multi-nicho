/**
 * Contrato do modelo de IA — o primeiro dos quatro pilares.
 *
 * O resto do sistema nunca importa o SDK da Anthropic nem o do Google.
 * Fala só com `LLMProvider`. Trocar de modelo é escrever um arquivo novo
 * nesta pasta e mudar uma variável de ambiente.
 */

/** Um pedaço de uma mensagem. Mapeia limpo para Anthropic e para Gemini. */
export type BlocoConteudo =
  | { tipo: "texto"; texto: string }
  | {
      tipo: "chamada_ferramenta";
      id: string;
      nome: string;
      argumentos: Record<string, unknown>;
    }
  | {
      tipo: "resultado_ferramenta";
      id: string;
      nome: string;
      conteudo: string;
      erro?: boolean;
    };

export interface MensagemLLM {
  papel: "user" | "assistant";
  blocos: BlocoConteudo[];
  /**
   * Conteúdo original devolvido pelo provider neste turno.
   *
   * Existe por um motivo específico: modelos com raciocínio estendido devolvem
   * blocos de pensamento que precisam voltar intactos na próxima requisição do
   * mesmo turno. Normalizar para `blocos` os descartaria. O driver reenvia
   * `bruto` quando presente e usa `blocos` quando não.
   */
  bruto?: unknown;
}

export interface DefinicaoFerramenta {
  nome: string;
  /** É por esta descrição que o modelo decide quando usar a ferramenta. */
  descricao: string;
  /** JSON Schema dos argumentos. */
  schema: Record<string, unknown>;
}

export interface RequisicaoLLM {
  /**
   * Bloco estável por tenant: persona, constituição, catálogo.
   *
   * Vai para o prompt cache. NÃO coloque data, hora, nome do contato nem
   * qualquer coisa que mude entre mensagens — o cache é casamento de prefixo
   * e um byte diferente invalida tudo depois dele.
   */
  sistema: string;
  /** Histórico do turno. Conteúdo volátil (agora, contato) entra aqui. */
  mensagens: MensagemLLM[];
  ferramentas: DefinicaoFerramenta[];
  maxTokens?: number;
  /** low | medium | high | xhigh | max */
  esforco?: EsforcoLLM;
}

export type EsforcoLLM = "low" | "medium" | "high" | "xhigh" | "max";

export type MotivoParada =
  | "fim"
  | "ferramenta"
  | "limite_tokens"
  | "recusa"
  | "pausa";

export interface UsoLLM {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

export interface RespostaLLM {
  /** Texto concatenado dos blocos de texto. Vazio quando só houve ferramenta. */
  texto: string;
  chamadas: Array<{
    id: string;
    nome: string;
    argumentos: Record<string, unknown>;
  }>;
  motivoParada: MotivoParada;
  uso: UsoLLM;
  modelo: string;
  /** Passar de volta em `MensagemLLM.bruto` na próxima iteração do turno. */
  bruto: unknown;
  latenciaMs: number;
}

export interface LLMProvider {
  readonly nome: string;
  readonly modelo: string;
  completar(req: RequisicaoLLM): Promise<RespostaLLM>;
}

/** Erro que vale a pena retentar ou cair para o provider reserva. */
export class ErroLLMTransitorio extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = "ErroLLMTransitorio";
  }
}

/** Erro de uso da API: schema inválido, requisição malformada. Não retenta. */
export class ErroLLMPermanente extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = "ErroLLMPermanente";
  }
}
