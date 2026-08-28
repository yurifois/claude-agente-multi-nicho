# Fase 1 — Fundação e cérebro do agente

**Data:** 2026-08-27
**Design:** [`2026-08-27-agente-atendimento-multinicho-design.md`](../specs/2026-08-27-agente-atendimento-multinicho-design.md)

## Entrega demonstrável

Abrir `/sandbox` no navegador, escolher um dos três nichos, conversar com o agente e ver — em um painel lateral — qual ferramenta ele escolheu a cada turno e por quê. **Sem WhatsApp, sem canal, sem conta Google.**

Se ao final desta fase o agente da advocacia não souber agendar (porque a ferramenta está desligada) e o da clínica souber, a fase cumpriu seu papel: a genericidade é real, não retórica.

## Fora do escopo desta fase

Canal de WhatsApp, painel do dono, funil, CRM, campanhas, cobrança, PWA, templates. Áudio e imagem entram na Fase 2 — aqui o sandbox é texto.

---

## Passos

Cada passo termina verificável. Nenhum passo depende de um posterior.

### 1. Scaffold e infraestrutura local

- `package.json` com scripts `dev`, `build`, `db:up`, `db:migrate`, `db:seed`, `test`, `docs`
- Next.js 16 (App Router) + TypeScript estrito + Tailwind v4
- `docker-compose.yml` com Postgres 16 exposto em `5433` (evita colidir com Postgres local)
- `.env.example` documentando toda variável; `.env` fora do git
- `assets/brand/tokens.css` importado no layout raiz; tema escuro como padrão

**Verificação:** `npm run db:up && npm run dev` sobe e a home mostra a marca no tema escuro.

### 2. Schema Prisma

Modelos desta fase, todos com `tenantId` exceto `Tenant` e `Usuario`:

`Tenant` · `Usuario` · `Membership` · `ConfigNegocio` · `Constituicao` · `Servico` · `Profissional` · `Persona` · `EtapaFunil` · `FerramentaAtiva` · `Marca` · `Contato` · `Conversa` · `Mensagem` · `Agendamento` · `TraceAgente`

`Conversa` já nasce com `pausada`, `resumo` e `janelaExpiraEm` — as fases seguintes preenchem, o schema não muda.

**Verificação:** `npm run db:migrate` aplica sem erro; `npx prisma studio` lista as tabelas.

### 3. Isolamento de tenant — as duas barreiras

- Prisma Client Extension que injeta `tenantId` em todo `where`/`create` dos modelos com tenant, e **lança exceção** se não houver tenant no contexto
- Migration com RLS: `ENABLE ROW LEVEL SECURITY` + policy por `current_setting('app.tenant_id')`
- `withTenant(tenantId, fn)` abre transação, faz `SET LOCAL app.tenant_id` e roda o callback
- Conexão separada de super-admin que ignora RLS

**Verificação:** teste que cria dois tenants, insere contato em cada um e prova que o tenant A não enxerga o do B — nem pela aplicação, nem por SQL cru com a role da aplicação. **Este teste é o mais importante da fase.**

### 4. Carregador de configuração de nicho

- Leitor de `config/nichos/<slug>/` com validação Zod de cada arquivo
- `seedTenant(slug, dadosDoTenant)` popula as tabelas a partir da pasta
- Cache em memória por tenant, invalidado na escrita

**Verificação:** `npm run db:seed` cria os três tenants; configuração inválida falha com mensagem que aponta o campo.

### 5. Os três nichos de exemplo

| Nicho | Prova |
|---|---|
| `clinica-estetica` | O caso do vídeo: agenda, preço por região, avaliação gratuita como objetivo |
| `petshop` | Preço que varia por porte do animal — catálogo com dimensão extra |
| `advocacia` | **Sem agenda e sem preço público** — ferramentas desligadas, objetivo é encaminhar a humano |

**Verificação:** os três seedam e produzem prompts diferentes, com listas de ferramentas diferentes.

### 6. `LLMProvider`

- Interface `completar(mensagens, ferramentas, opcoes)` → texto ou chamadas de ferramenta
- Driver Anthropic (padrão) e driver Gemini
- Normalização de tool-calling entre os dois formatos
- Retry com backoff; queda para o provider alternativo

**Verificação:** teste com servidor falso cobre resposta em texto, chamada de ferramenta, erro e queda de provider.

### 7. Registry de ferramentas

`Tool` = `nome` · `descricao` · `schema` Zod · `executar(args, ctx)`.

Desta fase: `buscar_conhecimento`, `ver_horarios_livres`, `listar_meus_horarios`, `criar_agendamento`, `cancelar_agendamento`, `salvar_contato`, `escalar_humano`.

O registry devolve **só as ferramentas ligadas em `FerramentaAtiva`** — é o mecanismo que faz a advocacia não ver agenda.

**Verificação:** teste que o registry da advocacia não contém nenhuma ferramenta de agenda.

### 8. Memória

Janela deslizante das últimas N mensagens (padrão 50, por tenant). Resumo rolante gravado em `Conversa.resumo` a cada N mensagens.

**Verificação:** teste que a mensagem 51 empurra a primeira para fora e que o resumo é gerado no limite.

### 9. Montagem do prompt

Na ordem do design: Objetivo → Ferramentas → Como agir → O que nunca fazer. Contexto: constituição, catálogo, data e hora no fuso do tenant, memória.

**Verificação:** snapshot test por nicho — a saída muda quando a configuração muda.

### 10. Loop do agente

Perceber → decidir → agir, com teto de iterações (padrão 6). Cada turno grava um `TraceAgente` com prompt, ferramentas chamadas, tokens e latência.

**Verificação:** teste de ponta a ponta com LLM falso: pergunta sobre horário dispara `ver_horarios_livres`; pergunta sobre preço não dispara ferramenta de agenda.

### 11. Guardrails

Os quatro do design: preço inventado, serviço inexistente, vazamento de rótulo, limite de tamanho. Violação regenera uma vez; reincidiu, escala.

**Verificação:** teste que injeta resposta com preço fora do catálogo e prova que não é enviada.

### 12. Sandbox

Rota `/sandbox`: seletor de nicho, chat, e painel lateral mostrando por turno as ferramentas chamadas, os argumentos, a latência e as violações de guardrail.

**Verificação:** conversar com os três nichos e ver comportamentos distintos.

---

## Ordem de execução

```
1 → 2 → 3 → 4 → 5
              ↓
    6 → 7 → 8 → 9 → 10 → 11 → 12
```

Passos 6 e 7 podem correr em paralelo com 4 e 5.

## Riscos

| Risco | Mitigação |
|---|---|
| RLS mal configurado dá falsa sensação de isolamento | O teste do passo 3 roda SQL cru com a role da aplicação, não só pela API do Prisma |
| Tool-calling do Gemini diverge do Anthropic | Normalizar na interface e cobrir os dois com o mesmo conjunto de testes |
| Prompt cresce demais e fica caro | `TraceAgente` mede tokens por turno desde o primeiro dia |
| Fuso horário errado quebra agendamento | Todo horário em UTC no banco; conversão só na borda, com o fuso do tenant |
