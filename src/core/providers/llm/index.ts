import { ProviderAnthropic } from "./anthropic";
import { ProviderGemini } from "./gemini";
import {
  ErroLLMPermanente,
  ErroLLMTransitorio,
  type EsforcoLLM,
  type LLMProvider,
  type RequisicaoLLM,
  type RespostaLLM,
} from "./tipos";

export * from "./tipos";
export { ProviderAnthropic } from "./anthropic";
export { ProviderGemini } from "./gemini";

export type NomeProvider = "anthropic" | "gemini";

export function criarProvider(nome: NomeProvider): LLMProvider {
  switch (nome) {
    case "anthropic":
      return new ProviderAnthropic();
    case "gemini":
      return new ProviderGemini();
  }
}

export interface OpcoesResiliencia {
  /** Tentativas por provider antes de desistir dele. */
  tentativas?: number;
  /** Espera base do backoff exponencial, em ms. */
  esperaBaseMs?: number;
  /** Injetável nos testes para não dormir de verdade. */
  dormir?: (ms: number) => Promise<void>;
}

/**
 * Envolve um provider primário com retry e queda para um reserva.
 *
 * A distinção que importa: erro transitório (429, 5xx, conexão) retenta e,
 * esgotado, cai para o reserva. Erro permanente (400, chave inválida) sobe
 * na hora — retentar uma requisição malformada só queima tempo, e cair para
 * o outro provider apenas esconde o bug.
 */
export class ProviderResiliente implements LLMProvider {
  readonly nome: string;
  readonly modelo: string;

  private readonly tentativas: number;
  private readonly esperaBaseMs: number;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(
    private readonly primario: LLMProvider,
    private readonly reserva?: LLMProvider,
    opcoes: OpcoesResiliencia = {},
  ) {
    this.nome = reserva
      ? `${primario.nome}+${reserva.nome}`
      : primario.nome;
    this.modelo = primario.modelo;
    this.tentativas = opcoes.tentativas ?? 3;
    this.esperaBaseMs = opcoes.esperaBaseMs ?? 400;
    this.dormir =
      opcoes.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async completar(req: RequisicaoLLM): Promise<RespostaLLM> {
    try {
      return await this.comRetry(this.primario, req);
    } catch (erro) {
      if (erro instanceof ErroLLMPermanente || !this.reserva) throw erro;
      return this.comRetry(this.reserva, req);
    }
  }

  private async comRetry(
    provider: LLMProvider,
    req: RequisicaoLLM,
  ): Promise<RespostaLLM> {
    let ultimo: unknown;

    for (let tentativa = 0; tentativa < this.tentativas; tentativa++) {
      try {
        return await provider.completar(req);
      } catch (erro) {
        if (erro instanceof ErroLLMPermanente) throw erro;
        ultimo = erro;
        if (tentativa < this.tentativas - 1) {
          // Backoff exponencial com jitter: sem o jitter, N workers que
          // tomaram 429 juntos voltam juntos e tomam 429 de novo.
          const espera =
            this.esperaBaseMs * 2 ** tentativa * (0.5 + Math.random());
          await this.dormir(espera);
        }
      }
    }

    throw ultimo instanceof Error
      ? ultimo
      : new ErroLLMTransitorio(
          `${provider.nome} falhou em ${this.tentativas} tentativas`,
          provider.nome,
        );
  }
}

let cache: LLMProvider | undefined;

/**
 * Provider configurado pelo ambiente. Memoizado — os SDKs mantêm pool de
 * conexões e recriar a cada mensagem desperdiça handshake.
 */
export function providerPadrao(): LLMProvider {
  if (cache) return cache;

  const primario = criarProvider(nomeValido(process.env.LLM_PROVIDER, "anthropic"));
  const nomeReserva = process.env.LLM_PROVIDER_FALLBACK?.trim();

  let reserva: LLMProvider | undefined;
  if (nomeReserva && nomeReserva !== primario.nome) {
    try {
      reserva = criarProvider(nomeValido(nomeReserva, "gemini"));
    } catch {
      // Reserva sem chave configurada não é erro: só desliga a queda.
      reserva = undefined;
    }
  }

  cache = new ProviderResiliente(primario, reserva);
  return cache;
}

/** Só para testes. */
export function limparCacheProvider(): void {
  cache = undefined;
}

export function esforcoPadrao(): EsforcoLLM {
  const bruto = process.env.LLM_EFFORT;
  const validos: EsforcoLLM[] = ["low", "medium", "high", "xhigh", "max"];
  return validos.find((v) => v === bruto) ?? "low";
}

export function maxTokensPadrao(): number {
  const bruto = Number(process.env.LLM_MAX_TOKENS);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 2000;
}

function nomeValido(bruto: string | undefined, padrao: NomeProvider): NomeProvider {
  return bruto === "anthropic" || bruto === "gemini" ? bruto : padrao;
}
