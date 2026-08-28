import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  LLMProvider,
  RequisicaoLLM,
  RespostaLLM,
} from "../providers/llm/tipos";
import { RegistryFerramentas } from "../tools/registry";
import type { ContextoFerramenta, FerramentaQualquer } from "../tools/tipos";
import { validarResposta, validarServicos } from "./guardrails";
import { executarTurno } from "./loop";
import { montarSistema, montarContextoVolatil } from "./prompt";

const CTX: ContextoFerramenta = {
  tenantId: "t1",
  conversaId: "c1",
  contatoId: "ct1",
  agora: new Date("2026-08-27T15:00:00Z"),
  fuso: "America/Sao_Paulo",
};

const CATALOGO = {
  precosCentavos: [60000, 12000],
  servicos: ["Botox", "Limpeza de pele"],
};

// ------------------------------------------------------------
// Ferramentas de teste
// ------------------------------------------------------------

function ferramentaAgenda(): FerramentaQualquer {
  return {
    nome: "ver_horarios_livres",
    descricao: "Consulta a agenda e devolve os horários realmente livres.",
    schema: z.object({ data: z.string() }),
    async executar() {
      return { conteudo: "Quinta 12:00 está livre." };
    },
  };
}

function ferramentaEscalar(): FerramentaQualquer {
  return {
    nome: "escalar_humano",
    descricao: "Passa a conversa para um atendente humano.",
    schema: z.object({ motivo: z.string() }),
    async executar() {
      return {
        conteudo: "Conversa encaminhada.",
        efeitos: { pausarConversa: true },
      };
    },
  };
}

function ferramentaCriar(): FerramentaQualquer {
  return {
    nome: "criar_agendamento",
    descricao: "Marca um horário na agenda.",
    schema: z.object({ inicio: z.string(), servico: z.string() }),
    async executar() {
      return { conteudo: "Agendado." };
    },
  };
}

/** Provider que segue um roteiro fixo de respostas. */
function providerRoteirizado(
  roteiro: Array<Partial<RespostaLLM>>,
): LLMProvider & { requisicoes: RequisicaoLLM[] } {
  let i = 0;
  return {
    nome: "falso",
    modelo: "falso-1",
    requisicoes: [] as RequisicaoLLM[],
    async completar(req: RequisicaoLLM): Promise<RespostaLLM> {
      this.requisicoes.push(req);
      const passo = roteiro[Math.min(i, roteiro.length - 1)] ?? {};
      i++;
      return {
        texto: "",
        chamadas: [],
        motivoParada: "fim",
        uso: { entrada: 100, saida: 20, cacheLeitura: 0, cacheEscrita: 0 },
        modelo: "falso-1",
        bruto: [],
        latenciaMs: 1,
        ...passo,
      };
    },
  };
}

// ------------------------------------------------------------

describe("RegistryFerramentas", () => {
  const completo = new RegistryFerramentas([
    ferramentaAgenda(),
    ferramentaCriar(),
    ferramentaEscalar(),
  ]);

  it("entrega so as ferramentas ligadas para o tenant", () => {
    // Este e o mecanismo inteiro da genericidade: a advocacia nao ve agenda
    // porque a agenda nao esta ligada, nao porque exista um if para ela.
    const advocacia = completo.paraTenant(["escalar_humano"]);

    expect(advocacia.nomes).toEqual(["escalar_humano"]);
    expect(advocacia.tem("criar_agendamento")).toBe(false);
    expect(advocacia.tem("ver_horarios_livres")).toBe(false);
  });

  it("a clinica ve as ferramentas de agenda", () => {
    const clinica = completo.paraTenant([
      "ver_horarios_livres",
      "criar_agendamento",
      "escalar_humano",
    ]);
    expect(clinica.tamanho).toBe(3);
    expect(clinica.tem("criar_agendamento")).toBe(true);
  });

  it("ordena as ferramentas para nao invalidar o prompt cache", () => {
    const a = completo.paraTenant(["escalar_humano", "criar_agendamento"]);
    const b = completo.paraTenant(["criar_agendamento", "escalar_humano"]);
    expect(a.nomes).toEqual(b.nomes);
  });

  it("devolve erro ao modelo em vez de estourar com argumento invalido", async () => {
    const r = await completo.executar("ver_horarios_livres", { data: 42 }, CTX);
    expect(r.erro).toBe(true);
    expect(r.conteudo).toContain("Argumentos inválidos");
  });

  it("avisa quando o modelo chama ferramenta inexistente", async () => {
    const r = await completo.executar("voar", {}, CTX);
    expect(r.erro).toBe(true);
    expect(r.conteudo).toContain("não existe");
  });
});

describe("guardrails", () => {
  it("barra preco que nao esta no catalogo", () => {
    const v = validarResposta("O botox sai por R$ 450", CATALOGO);
    expect(v).toHaveLength(1);
    expect(v[0]!.regra).toBe("preco_inventado");
  });

  it("aceita preco do catalogo em qualquer formato", () => {
    expect(validarResposta("Fica R$ 600", CATALOGO)).toHaveLength(0);
    expect(validarResposta("Fica R$ 600,00", CATALOGO)).toHaveLength(0);
    expect(validarResposta("São 600 reais", CATALOGO)).toHaveLength(0);
    expect(validarResposta("R$ 1.200,00", {
      ...CATALOGO,
      precosCentavos: [120000],
    })).toHaveLength(0);
  });

  it("aceita preco autorizado por ferramenta no turno", () => {
    const v = validarResposta("Seu link de R$ 250,00 está pronto", CATALOGO, {
      precosAutorizados: [25000],
    });
    expect(v).toHaveLength(0);
  });

  it("barra vazamento de rotulo interno", () => {
    const v = validarResposta(
      "Recebi seu [áudio do cliente] e entendi",
      CATALOGO,
    );
    expect(v.map((x) => x.regra)).toContain("vazamento_rotulo");
  });

  it("barra resposta longa demais", () => {
    const v = validarResposta("a".repeat(1500), CATALOGO);
    expect(v.map((x) => x.regra)).toContain("tamanho_excedido");
  });

  it("so acusa servico fora do catalogo quando houve oferta", () => {
    const vigiados = ["laser", "botox"];
    expect(
      validarServicos("Sim, fazemos laser aqui", CATALOGO, vigiados),
    ).toHaveLength(1);
    // Botox esta no catalogo — ofertar e legitimo.
    expect(
      validarServicos("Fazemos botox sim", CATALOGO, vigiados),
    ).toHaveLength(0);
    // Sem verbo de oferta, so mencionar nao acusa.
    expect(validarServicos("Voce perguntou sobre laser", CATALOGO, vigiados))
      .toHaveLength(0);
  });

  it("entende negacao — recusar um servico nao e oferecer", () => {
    const vigiados = ["laser", "botox"];
    for (const frase of [
      "Não trabalhamos com laser",
      "Nao fazemos laser",
      "Infelizmente não temos laser",
      "Nunca oferecemos laser",
    ]) {
      expect(validarServicos(frase, CATALOGO, vigiados), frase).toHaveLength(0);
    }
  });

  it("separa negacao e oferta na mesma frase", () => {
    // A negacao vale so para a oracao dela.
    const v = validarServicos(
      "Não fazemos laser, mas fazemos botox",
      CATALOGO,
      ["laser", "botox"],
    );
    expect(v).toHaveLength(0);
  });
});

describe("prompt", () => {
  const base = {
    negocio: { nome: "Clínica Renove" },
    persona: {
      objetivo: "Agendar avaliação gratuita.",
      tom: "Caloroso e objetivo.",
      comoAgir: "Trate por você.",
      nuncaFazer: "Não prometa resultado.",
    },
    constituicao: "A clínica fica na rua X.",
    servicos: [
      {
        nome: "Botox",
        precoCentavos: 60000,
        precoAPartirDe: true,
        duracaoMinutos: 45,
        variacoes: [],
        profissionais: ["Dra. Ana Silva"],
      },
    ],
    ferramentas: [
      { nome: "ver_horarios_livres", descricao: "Consulta a agenda.", schema: {} },
    ],
    horarios: [{ dia: 2, abre: "09:00", fecha: "18:00" }],
  };

  it("monta na ordem objetivo, ferramentas, como agir, nunca fazer", () => {
    const s = montarSistema(base);
    expect(s.indexOf("# Objetivo")).toBeLessThan(s.indexOf("# Ferramentas"));
    expect(s.indexOf("# Ferramentas")).toBeLessThan(s.indexOf("# Como agir"));
    expect(s.indexOf("# Como agir")).toBeLessThan(s.indexOf("# O que você NUNCA"));
  });

  it("NAO coloca data nem hora no bloco de sistema", () => {
    // Se o relogio entrar aqui, o prompt cache morre a cada mensagem.
    const s = montarSistema(base);
    expect(s).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(s.toLowerCase()).not.toContain("agora:");
  });

  it("e estavel entre chamadas — requisito do cache de prefixo", () => {
    expect(montarSistema(base)).toBe(montarSistema(base));
  });

  it("poe a data no contexto volatil, no fuso do tenant", () => {
    const c = montarContextoVolatil({
      agora: new Date("2026-08-27T15:00:00Z"),
      fuso: "America/Sao_Paulo",
    });
    expect(c).toContain("27/08/2026");
    expect(c).toContain("12:00"); // 15:00 UTC = 12:00 em Sao Paulo
  });

  it("marca preco 'a partir de' para o modelo nao afirmar valor fechado", () => {
    expect(montarSistema(base)).toContain("a partir de");
  });

  it("avisa quando o nicho nao tem ferramenta nenhuma", () => {
    const s = montarSistema({ ...base, ferramentas: [] });
    expect(s).toContain("não tem ferramentas");
  });
});

describe("executarTurno", () => {
  const registry = new RegistryFerramentas([
    ferramentaAgenda(),
    ferramentaCriar(),
    ferramentaEscalar(),
  ]);

  const entradaBase = {
    sistema: "sistema",
    mensagens: [
      { papel: "user" as const, blocos: [{ tipo: "texto" as const, texto: "oi" }] },
    ],
    catalogo: CATALOGO,
  };

  it("devolve o texto quando o modelo responde sem ferramenta", async () => {
    const provider = providerRoteirizado([{ texto: "Boa tarde! Como ajudo?" }]);
    const r = await executarTurno(provider, registry, entradaBase, CTX);

    expect(r.resposta).toBe("Boa tarde! Como ajudo?");
    expect(r.iteracoes).toBe(1);
    expect(r.chamadas).toHaveLength(0);
    expect(r.escalar).toBe(false);
  });

  it("executa a ferramenta e volta ao modelo com o resultado", async () => {
    const provider = providerRoteirizado([
      {
        chamadas: [
          { id: "1", nome: "ver_horarios_livres", argumentos: { data: "2026-08-28" } },
        ],
        motivoParada: "ferramenta",
      },
      { texto: "Tenho quinta às 12h." },
    ]);

    const r = await executarTurno(provider, registry, entradaBase, CTX);

    expect(r.iteracoes).toBe(2);
    expect(r.chamadas.map((c) => c.nome)).toEqual(["ver_horarios_livres"]);
    expect(r.resposta).toBe("Tenho quinta às 12h.");
  });

  it("devolve resultados paralelos numa unica mensagem", async () => {
    // Quebrar em varias mensagens ensina o modelo a parar de pedir em paralelo.
    const provider = providerRoteirizado([
      {
        chamadas: [
          { id: "1", nome: "ver_horarios_livres", argumentos: { data: "x" } },
          { id: "2", nome: "criar_agendamento", argumentos: { inicio: "y", servico: "Botox" } },
        ],
        motivoParada: "ferramenta",
      },
      { texto: "Pronto!" },
    ]);

    await executarTurno(provider, registry, entradaBase, CTX);

    const segunda = provider.requisicoes[1]!;
    const comResultados = segunda.mensagens.filter((m) =>
      m.blocos.some((b) => b.tipo === "resultado_ferramenta"),
    );
    expect(comResultados).toHaveLength(1);
    expect(comResultados[0]!.blocos).toHaveLength(2);
  });

  it("regenera uma vez quando o guardrail barra", async () => {
    const provider = providerRoteirizado([
      { texto: "O botox sai por R$ 450" }, // inventado
      { texto: "O botox sai a partir de R$ 600" }, // corrigido
    ]);

    const r = await executarTurno(provider, registry, entradaBase, CTX);

    expect(r.resposta).toContain("R$ 600");
    expect(r.violacoes).toHaveLength(1);
    expect(r.escalar).toBe(false);
  });

  it("escala quando insiste no preco inventado", async () => {
    const provider = providerRoteirizado([{ texto: "Sai por R$ 450" }]);
    const r = await executarTurno(provider, registry, entradaBase, CTX);

    expect(r.resposta).toBe("");
    expect(r.escalar).toBe(true);
    expect(r.motivoEscalada).toContain("preco_inventado");
  });

  it("escala quando a ferramenta pede atendimento humano", async () => {
    const provider = providerRoteirizado([
      {
        chamadas: [{ id: "1", nome: "escalar_humano", argumentos: { motivo: "reclamação" } }],
        motivoParada: "ferramenta",
      },
      { texto: "Já vou chamar alguém." },
    ]);

    const r = await executarTurno(provider, registry, entradaBase, CTX);
    expect(r.escalar).toBe(true);
    expect(r.resposta).toBe("Já vou chamar alguém.");
  });

  it("para no teto de iteracoes em vez de girar para sempre", async () => {
    const provider = providerRoteirizado([
      {
        chamadas: [{ id: "1", nome: "ver_horarios_livres", argumentos: { data: "x" } }],
        motivoParada: "ferramenta",
      },
    ]);

    const r = await executarTurno(provider, registry, entradaBase, CTX, {
      maxIteracoes: 3,
    });

    expect(r.iteracoes).toBe(3);
    expect(r.escalar).toBe(true);
    expect(r.motivoEscalada).toContain("teto");
  });

  it("escala quando o modelo recusa", async () => {
    const provider = providerRoteirizado([{ motivoParada: "recusa" }]);
    const r = await executarTurno(provider, registry, entradaBase, CTX);
    expect(r.escalar).toBe(true);
    expect(r.motivoEscalada).toContain("recusou");
  });

  it("soma o uso de todas as iteracoes", async () => {
    const provider = providerRoteirizado([
      {
        chamadas: [{ id: "1", nome: "ver_horarios_livres", argumentos: { data: "x" } }],
        motivoParada: "ferramenta",
      },
      { texto: "ok" },
    ]);

    const r = await executarTurno(provider, registry, entradaBase, CTX);
    expect(r.uso.entrada).toBe(200);
    expect(r.uso.saida).toBe(40);
  });
});
