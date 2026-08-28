/**
 * Guardrails — validação determinística da resposta antes de ela sair.
 *
 * O prompt não basta. Instruir "nunca invente preço" reduz a chance, não a
 * elimina — e um preço inventado que chega no cliente vira reclamação, ou
 * pior, obrigação. Estes checks não são probabilísticos: ou o número está no
 * catálogo, ou a resposta não sai.
 *
 * Violação regenera uma vez com o erro no contexto. Reincidiu, escala.
 */

export type RegraGuardrail =
  | "preco_inventado"
  | "servico_inexistente"
  | "vazamento_rotulo"
  | "tamanho_excedido";

export interface Violacao {
  regra: RegraGuardrail;
  /** O trecho que causou a violação. Vira a dica na regeneração. */
  trecho: string;
  detalhe: string;
}

export interface CatalogoConhecido {
  /** Todo valor em centavos que pode ser citado. */
  precosCentavos: number[];
  /** Nomes de serviço do catálogo, como escritos. */
  servicos: string[];
}

export interface OpcoesGuardrail {
  /** Acima disso a resposta é quebrada, não truncada. */
  maxCaracteres?: number;
  /** Preços criados por ferramenta neste turno (ex.: cobrança gerada). */
  precosAutorizados?: number[];
}

const ROTULOS_PROIBIDOS = [
  "[áudio do cliente]",
  "[audio do cliente]",
  "[imagem do cliente]",
  "[contexto]",
  "transcrição",
  "transcricao",
];

/** Captura R$ 1.234,56 · R$ 600 · 600 reais · R$600,00 */
const REGEX_MOEDA =
  /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)|(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+)\s+reais/gi;

export function validarResposta(
  texto: string,
  catalogo: CatalogoConhecido,
  opcoes: OpcoesGuardrail = {},
): Violacao[] {
  const violacoes: Violacao[] = [];
  const maxCaracteres = opcoes.maxCaracteres ?? 1200;

  const autorizados = new Set([
    ...catalogo.precosCentavos,
    ...(opcoes.precosAutorizados ?? []),
  ]);

  for (const { texto: bruto, centavos } of extrairValores(texto)) {
    if (!autorizados.has(centavos)) {
      violacoes.push({
        regra: "preco_inventado",
        trecho: bruto,
        detalhe:
          `O valor ${bruto} não existe no catálogo. ` +
          `Cite apenas valores do catálogo ou não cite valor nenhum.`,
      });
    }
  }

  const minusculo = texto.toLowerCase();
  for (const rotulo of ROTULOS_PROIBIDOS) {
    if (minusculo.includes(rotulo.toLowerCase())) {
      violacoes.push({
        regra: "vazamento_rotulo",
        trecho: rotulo,
        detalhe:
          `A resposta expôs "${rotulo}", que é mecânica interna. ` +
          `Responda como se o cliente tivesse falado com você diretamente.`,
      });
    }
  }

  if (texto.length > maxCaracteres) {
    violacoes.push({
      regra: "tamanho_excedido",
      trecho: `${texto.length} caracteres`,
      detalhe:
        `A resposta passou de ${maxCaracteres} caracteres. ` +
        `WhatsApp pede mensagens curtas — reduza.`,
    });
  }

  return violacoes;
}

/**
 * Verifica menção a serviço fora do catálogo.
 *
 * Separado de `validarResposta` porque é o check mais sujeito a falso
 * positivo: o agente pode legitimamente dizer "não trabalhamos com laser".
 * Só é aplicado quando o texto tem marca de oferta.
 */
export function validarServicos(
  texto: string,
  catalogo: CatalogoConhecido,
  ofertasConhecidas: string[],
): Violacao[] {
  const doCatalogo = new Set(catalogo.servicos.map((s) => s.toLowerCase()));
  const violados = new Set<string>();

  // Por oração, não pelo texto inteiro. "Não fazemos laser, mas fazemos
  // botox" carrega uma negação e uma oferta na mesma frase; olhar o texto
  // todo acusaria o laser indevidamente.
  for (const oracao of dividirEmOracoes(texto)) {
    if (!ofertaAfirmativa(oracao)) continue;

    const minusculo = oracao.toLowerCase();
    for (const termo of ofertasConhecidas) {
      const t = termo.toLowerCase();
      if (minusculo.includes(t) && !doCatalogo.has(t)) violados.add(termo);
    }
  }

  return [...violados].map((termo) => ({
    regra: "servico_inexistente" as const,
    trecho: termo,
    detalhe:
      `"${termo}" não está no catálogo. ` +
      `Não ofereça serviços que a empresa não presta.`,
  }));
}

const VERBOS_OFERTA = /\b(fazemos|oferecemos|temos|realizamos|trabalhamos com)\b/gi;
const NEGACOES = /\b(n[ãa]o|nunca|jamais|infelizmente|deixamos de)\b/i;

/** A oração oferece o serviço, ou nega que ofereça? */
function ofertaAfirmativa(oracao: string): boolean {
  for (const m of oracao.matchAll(VERBOS_OFERTA)) {
    // Negação vive antes do verbo: "não fazemos", "nunca trabalhamos com".
    const antes = oracao.slice(0, m.index);
    if (!NEGACOES.test(antes)) return true;
  }
  return false;
}

function dividirEmOracoes(texto: string): string[] {
  return texto
    .split(/[.!?;\n]+|,\s*(?=mas|porém|contudo|embora)/i)
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Converte o texto das violações em instrução de correção para o modelo. */
export function dicaDeCorrecao(violacoes: Violacao[]): string {
  return (
    `Sua resposta anterior não pode ser enviada:\n` +
    violacoes.map((v) => `- ${v.detalhe}`).join("\n") +
    `\n\nReescreva corrigindo isso. Não comente a correção com o cliente.`
  );
}

interface ValorEncontrado {
  texto: string;
  centavos: number;
}

function extrairValores(texto: string): ValorEncontrado[] {
  const achados: ValorEncontrado[] = [];

  for (const m of texto.matchAll(REGEX_MOEDA)) {
    const numero = m[1] ?? m[2];
    if (!numero) continue;

    const centavos = paraCentavos(numero);
    if (centavos === undefined) continue;

    achados.push({ texto: m[0].trim(), centavos });
  }

  return achados;
}

function paraCentavos(bruto: string): number | undefined {
  // pt-BR: ponto é milhar, vírgula é decimal.
  const normalizado = bruto.replace(/\./g, "").replace(",", ".");
  const valor = Number(normalizado);
  if (!Number.isFinite(valor)) return undefined;
  return Math.round(valor * 100);
}
