import type {
  LLMProvider,
  MensagemLLM,
  RespostaLLM,
  EsforcoLLM,
} from "../providers/llm/tipos";
import type { RegistryFerramentas } from "../tools/registry";
import type { ContextoFerramenta } from "../tools/tipos";
import {
  dicaDeCorrecao,
  validarResposta,
  validarServicos,
  type CatalogoConhecido,
  type Violacao,
} from "./guardrails";

/**
 * O loop do agente: perceber → decidir → agir.
 *
 * Cada iteração é uma ida ao modelo. Ele responde com texto (acabou) ou com
 * chamadas de ferramenta (executa e volta). O teto de iterações existe porque
 * um modelo confuso consegue ficar chamando ferramenta para sempre, e um
 * cliente esperando é pior que uma resposta imperfeita.
 */

export interface EntradaTurno {
  /** Bloco estável, já montado. Vai para o cache. */
  sistema: string;
  /** Histórico: memória + contexto volátil + mensagem nova. */
  mensagens: MensagemLLM[];
  catalogo: CatalogoConhecido;
  /** Termos que o guardrail vigia como possível oferta indevida. */
  ofertasVigiadas?: string[];
}

export interface OpcoesTurno {
  maxIteracoes?: number;
  maxTokens?: number;
  esforco?: EsforcoLLM;
  maxCaracteresResposta?: number;
  /** Quantas vezes tentar corrigir uma violação antes de escalar. */
  tentativasCorrecao?: number;
}

export interface ChamadaExecutada {
  nome: string;
  argumentos: Record<string, unknown>;
  resultado: string;
  erro: boolean;
  latenciaMs: number;
}

export interface ResultadoTurno {
  /** Texto a enviar. Vazio quando o turno terminou escalando. */
  resposta: string;
  /** A conversa deve ser passada a um humano. */
  escalar: boolean;
  motivoEscalada?: string;
  iteracoes: number;
  chamadas: ChamadaExecutada[];
  violacoes: Violacao[];
  uso: { entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number };
  latenciaMs: number;
  modelo: string;
  provider: string;
}

export async function executarTurno(
  provider: LLMProvider,
  registry: RegistryFerramentas,
  entrada: EntradaTurno,
  ctx: ContextoFerramenta,
  opcoes: OpcoesTurno = {},
): Promise<ResultadoTurno> {
  const maxIteracoes = opcoes.maxIteracoes ?? 6;
  const tentativasCorrecao = opcoes.tentativasCorrecao ?? 1;
  const inicio = Date.now();

  const mensagens: MensagemLLM[] = [...entrada.mensagens];
  const chamadas: ChamadaExecutada[] = [];
  const violacoesAcumuladas: Violacao[] = [];
  const precosAutorizados: number[] = [];

  const uso = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 };
  let iteracoes = 0;
  let correcoesUsadas = 0;
  let pausarPorFerramenta = false;
  let ultima: RespostaLLM | undefined;

  while (iteracoes < maxIteracoes) {
    iteracoes++;

    const resposta = await provider.completar({
      sistema: entrada.sistema,
      mensagens,
      ferramentas: registry.definicoes(),
      maxTokens: opcoes.maxTokens,
      esforco: opcoes.esforco,
    });
    ultima = resposta;

    uso.entrada += resposta.uso.entrada;
    uso.saida += resposta.uso.saida;
    uso.cacheLeitura += resposta.uso.cacheLeitura;
    uso.cacheEscrita += resposta.uso.cacheEscrita;

    if (resposta.motivoParada === "recusa") {
      return encerrar({
        resposta: "",
        escalar: true,
        motivoEscalada: "o modelo recusou responder",
      });
    }

    // ---- Caminho A: o modelo quer usar ferramentas ----
    if (resposta.chamadas.length > 0) {
      mensagens.push({
        papel: "assistant",
        blocos: resposta.chamadas.map((c) => ({
          tipo: "chamada_ferramenta" as const,
          id: c.id,
          nome: c.nome,
          argumentos: c.argumentos,
        })),
        bruto: resposta.bruto,
      });

      // Em paralelo: o modelo pede várias de uma vez e elas são
      // independentes. Serializar só somaria latência.
      const resultados = await Promise.all(
        resposta.chamadas.map(async (c) => {
          const t0 = Date.now();
          const r = await registry.executar(c.nome, c.argumentos, ctx);
          return { chamada: c, resultado: r, latenciaMs: Date.now() - t0 };
        }),
      );

      for (const { chamada, resultado, latenciaMs } of resultados) {
        chamadas.push({
          nome: chamada.nome,
          argumentos: chamada.argumentos,
          resultado: resultado.conteudo,
          erro: resultado.erro ?? false,
          latenciaMs,
        });
        if (resultado.efeitos?.pausarConversa) pausarPorFerramenta = true;
        if (resultado.efeitos?.precosAutorizados) {
          precosAutorizados.push(...resultado.efeitos.precosAutorizados);
        }
      }

      // Todos os resultados voltam numa ÚNICA mensagem. Quebrar em várias
      // ensina o modelo a parar de pedir ferramentas em paralelo.
      mensagens.push({
        papel: "user",
        blocos: resultados.map(({ chamada, resultado }) => ({
          tipo: "resultado_ferramenta" as const,
          id: chamada.id,
          nome: chamada.nome,
          conteudo: resultado.conteudo,
          erro: resultado.erro,
        })),
      });

      continue;
    }

    // ---- Caminho B: o modelo respondeu em texto ----
    const violacoes = [
      ...validarResposta(resposta.texto, entrada.catalogo, {
        maxCaracteres: opcoes.maxCaracteresResposta,
        precosAutorizados,
      }),
      ...validarServicos(
        resposta.texto,
        entrada.catalogo,
        entrada.ofertasVigiadas ?? [],
      ),
    ];

    if (violacoes.length === 0) {
      return encerrar({
        resposta: resposta.texto,
        escalar: pausarPorFerramenta,
        motivoEscalada: pausarPorFerramenta
          ? "uma ferramenta pediu atendimento humano"
          : undefined,
      });
    }

    violacoesAcumuladas.push(...violacoes);

    if (correcoesUsadas >= tentativasCorrecao) {
      // Errou de novo depois de avisado. Escalar é mais barato que insistir.
      return encerrar({
        resposta: "",
        escalar: true,
        motivoEscalada: `violação de guardrail persistente: ${violacoes
          .map((v) => v.regra)
          .join(", ")}`,
      });
    }

    correcoesUsadas++;
    mensagens.push({
      papel: "assistant",
      blocos: [{ tipo: "texto", texto: resposta.texto }],
      bruto: resposta.bruto,
    });
    mensagens.push({
      papel: "user",
      blocos: [{ tipo: "texto", texto: dicaDeCorrecao(violacoes) }],
    });
  }

  return encerrar({
    resposta: "",
    escalar: true,
    motivoEscalada: `o agente atingiu o teto de ${maxIteracoes} iterações`,
  });

  function encerrar(
    parcial: Pick<ResultadoTurno, "resposta" | "escalar" | "motivoEscalada">,
  ): ResultadoTurno {
    return {
      ...parcial,
      iteracoes,
      chamadas,
      violacoes: violacoesAcumuladas,
      uso,
      latenciaMs: Date.now() - inicio,
      modelo: ultima?.modelo ?? provider.modelo,
      provider: provider.nome,
    };
  }
}
