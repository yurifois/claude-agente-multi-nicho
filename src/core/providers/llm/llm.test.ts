import { describe, expect, it, vi } from "vitest";

import { ProviderResiliente } from "./index";
import {
  ErroLLMPermanente,
  ErroLLMTransitorio,
  type LLMProvider,
  type RequisicaoLLM,
  type RespostaLLM,
} from "./tipos";

const REQ: RequisicaoLLM = {
  sistema: "voce e um atendente",
  mensagens: [{ papel: "user", blocos: [{ tipo: "texto", texto: "oi" }] }],
  ferramentas: [],
};

function respostaFalsa(modelo: string, texto = "ok"): RespostaLLM {
  return {
    texto,
    chamadas: [],
    motivoParada: "fim",
    uso: { entrada: 10, saida: 5, cacheLeitura: 0, cacheEscrita: 0 },
    modelo,
    bruto: [],
    latenciaMs: 1,
  };
}

/** Provider de teste que segue um roteiro de resultados por chamada. */
function providerFalso(
  nome: string,
  roteiro: Array<RespostaLLM | Error>,
): LLMProvider & { chamadas: number } {
  let i = 0;
  return {
    nome,
    modelo: `${nome}-teste`,
    chamadas: 0,
    async completar() {
      this.chamadas++;
      const passo = roteiro[Math.min(i, roteiro.length - 1)];
      i++;
      if (passo instanceof Error) throw passo;
      return passo!;
    },
  };
}

const semDormir = { dormir: async () => {} };

describe("ProviderResiliente", () => {
  it("devolve a resposta do primario quando ele funciona", async () => {
    const primario = providerFalso("p", [respostaFalsa("p-teste")]);
    const reserva = providerFalso("r", [respostaFalsa("r-teste")]);

    const resposta = await new ProviderResiliente(primario, reserva, semDormir)
      .completar(REQ);

    expect(resposta.modelo).toBe("p-teste");
    expect(reserva.chamadas).toBe(0);
  });

  it("retenta erro transitorio antes de desistir do primario", async () => {
    const primario = providerFalso("p", [
      new ErroLLMTransitorio("429", "p"),
      new ErroLLMTransitorio("429", "p"),
      respostaFalsa("p-teste"),
    ]);

    const resposta = await new ProviderResiliente(primario, undefined, semDormir)
      .completar(REQ);

    expect(resposta.modelo).toBe("p-teste");
    expect(primario.chamadas).toBe(3);
  });

  it("cai para o reserva quando o primario esgota as tentativas", async () => {
    const primario = providerFalso("p", [new ErroLLMTransitorio("500", "p")]);
    const reserva = providerFalso("r", [respostaFalsa("r-teste")]);

    const resposta = await new ProviderResiliente(primario, reserva, semDormir)
      .completar(REQ);

    expect(resposta.modelo).toBe("r-teste");
    expect(primario.chamadas).toBe(3);
    expect(reserva.chamadas).toBe(1);
  });

  it("NAO retenta nem cai quando o erro e permanente", async () => {
    // Uma requisicao malformada falha igual no reserva. Retentar so queima
    // tempo, e cair para o outro provider esconderia o bug.
    const primario = providerFalso("p", [
      new ErroLLMPermanente("schema invalido", "p"),
    ]);
    const reserva = providerFalso("r", [respostaFalsa("r-teste")]);

    await expect(
      new ProviderResiliente(primario, reserva, semDormir).completar(REQ),
    ).rejects.toThrow(ErroLLMPermanente);

    expect(primario.chamadas).toBe(1);
    expect(reserva.chamadas).toBe(0);
  });

  it("propaga o erro quando primario e reserva falham", async () => {
    const primario = providerFalso("p", [new ErroLLMTransitorio("500", "p")]);
    const reserva = providerFalso("r", [new ErroLLMTransitorio("500", "r")]);

    await expect(
      new ProviderResiliente(primario, reserva, semDormir).completar(REQ),
    ).rejects.toThrow(ErroLLMTransitorio);

    expect(reserva.chamadas).toBe(3);
  });

  it("aplica jitter no backoff para nao sincronizar workers", async () => {
    const esperas: number[] = [];
    const primario = providerFalso("p", [
      new ErroLLMTransitorio("429", "p"),
      new ErroLLMTransitorio("429", "p"),
      respostaFalsa("p-teste"),
    ]);

    const aleatorio = vi.spyOn(Math, "random");
    aleatorio.mockReturnValueOnce(0).mockReturnValueOnce(1);

    await new ProviderResiliente(primario, undefined, {
      esperaBaseMs: 100,
      dormir: async (ms) => {
        esperas.push(ms);
      },
    }).completar(REQ);

    aleatorio.mockRestore();

    // base * 2^0 * (0.5 + 0) = 50 ; base * 2^1 * (0.5 + 1) = 300
    expect(esperas).toEqual([50, 300]);
  });
});
