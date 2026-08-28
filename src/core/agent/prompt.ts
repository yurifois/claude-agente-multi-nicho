import type { DefinicaoFerramenta } from "../providers/llm/tipos";

/**
 * Montagem do prompt — o segundo pilar.
 *
 * A ordem não é estética. O modelo precisa saber, nesta sequência:
 * qual é o objetivo, o que tem à disposição, como agir, e o que nunca fazer.
 *
 * A DIVISÃO entre `montarSistema` e `montarContextoVolatil` é a coisa mais
 * importante deste arquivo. O prompt cache é casamento de prefixo: um único
 * byte diferente invalida tudo depois dele. A constituição de um tenant tem
 * milhares de tokens e é idêntica em toda mensagem — é o caso perfeito para
 * cache. Se a data e hora entrarem aqui junto dela, o cache morre a cada
 * mensagem e o desconto de ~90% nunca acontece.
 *
 * Regra: nada que mude entre duas mensagens do mesmo tenant entra em
 * `montarSistema`.
 */

export interface ServicoPrompt {
  nome: string;
  descricao?: string | null;
  precoCentavos?: number | null;
  precoAPartirDe: boolean;
  duracaoMinutos?: number | null;
  variacoes: Array<{ rotulo: string; precoCentavos?: number | null }>;
  profissionais: string[];
}

export interface PersonaPrompt {
  objetivo: string;
  tom: string;
  comoAgir: string;
  nuncaFazer: string;
}

export interface EntradaSistema {
  negocio: { nome: string; endereco?: string | null; telefone?: string | null };
  persona: PersonaPrompt;
  constituicao: string;
  servicos: ServicoPrompt[];
  ferramentas: DefinicaoFerramenta[];
  /** Horário de funcionamento, estável. 0=domingo. */
  horarios: Array<{ dia: number; abre: string; fecha: string }>;
}

const DIAS = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];

/**
 * Bloco de sistema: estável por tenant. Vai para o prompt cache.
 */
export function montarSistema(e: EntradaSistema): string {
  const partes: string[] = [];

  partes.push(
    `Você é o atendente virtual de ${e.negocio.nome}. ` +
      `Conversa por WhatsApp com clientes reais.`,
  );

  partes.push(`# Objetivo\n\n${e.persona.objetivo.trim()}`);

  partes.push(
    `# Ferramentas disponíveis\n\n` +
      (e.ferramentas.length === 0
        ? "Você não tem ferramentas nesta conversa. Responda apenas com o que está na base de conhecimento."
        : e.ferramentas
            .map((f) => `- \`${f.nome}\` — ${f.descricao}`)
            .join("\n")),
  );

  partes.push(`# Como agir\n\n${e.persona.comoAgir.trim()}\n\n${regrasFixas()}`);

  partes.push(
    `# O que você NUNCA deve fazer\n\n${e.persona.nuncaFazer.trim()}\n\n${proibicoesFixas()}`,
  );

  partes.push(`# Tom\n\n${e.persona.tom.trim()}`);

  partes.push(`# Base de conhecimento\n\n${e.constituicao.trim()}`);

  if (e.servicos.length > 0) {
    partes.push(`# Catálogo\n\n${renderizarCatalogo(e.servicos)}`);
  }

  if (e.horarios.length > 0) {
    partes.push(
      `# Horário de funcionamento\n\n` +
        e.horarios
          .map((h) => `- ${DIAS[h.dia] ?? `dia ${h.dia}`}: ${h.abre} às ${h.fecha}`)
          .join("\n"),
    );
  }

  return partes.join("\n\n---\n\n");
}

/**
 * Contexto que muda a cada mensagem. Entra do lado das mensagens, DEPOIS da
 * fronteira do cache — nunca no bloco de sistema.
 */
export function montarContextoVolatil(entrada: {
  agora: Date;
  fuso: string;
  nomeContato?: string | null;
  resumoConversa?: string | null;
}): string {
  const linhas: string[] = [];

  const formatador = new Intl.DateTimeFormat("pt-BR", {
    timeZone: entrada.fuso,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  linhas.push(`Agora: ${formatador.format(entrada.agora)} (${entrada.fuso}).`);

  if (entrada.nomeContato) {
    linhas.push(`Nome do cliente: ${entrada.nomeContato}.`);
  }
  if (entrada.resumoConversa) {
    linhas.push(`Resumo do que já foi conversado: ${entrada.resumoConversa}`);
  }

  return `[contexto]\n${linhas.join("\n")}`;
}

function regrasFixas(): string {
  return [
    "- Uma pergunta de cada vez. Mensagens curtas, como se digitasse no celular.",
    "- Mensagens que chegam marcadas como `[áudio do cliente]` ou `[imagem do cliente]` já vêm convertidas em texto. Trate como fala normal do cliente e responda sem mencionar transcrição, descrição ou qualquer rótulo.",
    "- Se o cliente mandar várias mensagens seguidas, elas chegam juntas. Responda a todas de uma vez, não uma por uma.",
    "- Antes de afirmar um horário livre, consulte a agenda. Não deduza a partir do horário de funcionamento.",
    "- Quando não souber algo, use `escalar_humano` em vez de improvisar.",
  ].join("\n");
}

function proibicoesFixas(): string {
  return [
    "- Nunca invente preço, prazo, promoção ou condição de pagamento. Só existe o que está no catálogo.",
    "- Nunca ofereça serviço que não esteja no catálogo.",
    "- Nunca confirme agendamento sem ter usado a ferramenta que cria o agendamento.",
    "- Nunca diga que é uma inteligência artificial a menos que perguntem diretamente.",
    "- Nunca peça dados sensíveis: senha, cartão, documento completo.",
  ].join("\n");
}

function renderizarCatalogo(servicos: ServicoPrompt[]): string {
  return servicos
    .map((s) => {
      const linhas: string[] = [`## ${s.nome}`];
      if (s.descricao) linhas.push(s.descricao);

      if (s.precoCentavos != null) {
        linhas.push(
          `Preço: ${s.precoAPartirDe ? "a partir de " : ""}${moeda(s.precoCentavos)}`,
        );
      } else if (s.variacoes.length === 0) {
        linhas.push(
          "Preço: não divulgado por mensagem — encaminhe para avaliação.",
        );
      }

      if (s.variacoes.length > 0) {
        linhas.push(
          "Variações:\n" +
            s.variacoes
              .map(
                (v) =>
                  `- ${v.rotulo}: ${
                    v.precoCentavos != null ? moeda(v.precoCentavos) : "sob consulta"
                  }`,
              )
              .join("\n"),
        );
      }

      if (s.duracaoMinutos) linhas.push(`Duração: ${s.duracaoMinutos} minutos`);
      if (s.profissionais.length > 0) {
        linhas.push(`Realizado por: ${s.profissionais.join(", ")}`);
      }

      return linhas.join("\n");
    })
    .join("\n\n");
}

export function moeda(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}
