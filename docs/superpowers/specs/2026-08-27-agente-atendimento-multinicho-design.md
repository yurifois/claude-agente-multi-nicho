# Agente de Atendimento Multi-Nicho — Design

**Data:** 2026-08-27
**Status:** aguardando revisão do usuário
**Origem:** arquitetura destilada do vídeo *"Como criei o MELHOR Agente de IA pra WhatsApp do Brasil"* (transcrição em `docs/transcricao-video.txt`), generalizada para qualquer nicho.

---

## 1. Objetivo

Construir uma plataforma SaaS multi-tenant onde qualquer empresa — clínica, pet shop, escritório de advocacia, oficina, academia — sobe um agente de IA de atendimento por WhatsApp **sem escrever código**, e o dono opera tudo por um painel web instalável.

O que o vídeo entrega para uma clínica de estética, esta plataforma entrega para qualquer nicho, com multi-tenancy, cobrança, campanhas e templates oficiais da Meta por cima.

### Critérios de sucesso

1. Um novo nicho entra em produção editando apenas configuração — zero alteração de código.
2. O agente nunca cita preço, prazo ou promoção que não exista no catálogo do tenant.
3. O dono assume e devolve qualquer conversa ao agente sem perder contexto.
4. O simulador agente-contra-agente atinge 0 violações em 100 conversas antes do go-live.
5. Um tenant jamais lê ou escreve dado de outro tenant.

---

## 2. Fundamento conceitual

### 2.1 Os quatro pilares

O vídeo define quatro pilares sem os quais não existe agente. Esta é a espinha do sistema:

| Pilar | Papel | Onde vive |
|---|---|---|
| **Modelo de IA** | Escolhe quais ferramentas usar e redige a resposta | `core/providers/llm/` |
| **Prompt** | Objetivo · Ferramentas · Como agir · O que nunca fazer | `core/agent/prompt.ts` |
| **Ferramentas** | Código autônomo que age no mundo | `core/tools/` |
| **Memória** | Últimas N mensagens por contato | `core/agent/memory.ts` |

Sem ferramentas não é agente — é um modelo redigindo texto. Sem memória, cada mensagem reinicia a conversa. Sem base de conhecimento, o modelo inventa.

### 2.2 Agente vs. automação linear

Automação linear segue trilho fixo, aceita entrada previsível (formulário), custa zero e não erra de caminho. Agente escolhe o caminho mensagem a mensagem e serve entrada imprevisível — texto torto, áudio, foto.

**Regra de projeto:** todo fluxo determinístico do sistema (sincronizar planilha, enviar lembrete, cobrar assinatura, disparar campanha) é automação linear em job agendado. O modelo de IA só é invocado no ponto onde a entrada é uma pessoa falando. Isso corta custo e elimina margem de erro onde ela não precisa existir.

---

## 3. Arquitetura

### 3.1 Stack

| Camada | Escolha |
|---|---|
| App + painel | Next.js 15 (App Router) + TypeScript |
| UI | Tailwind + shadcn/ui, tokens semânticos por tenant |
| Banco | PostgreSQL + Prisma |
| Fila e agendamento | pg-boss (dentro do Postgres, sem Redis) |
| LLM | Claude Sonnet 5 (padrão) · Gemini (alternativo) |
| Transcrição | Whisper (OpenAI/Groq) · Gemini como alternativa |
| Canal | Adaptador plugável: Evolution API (padrão) · Meta Cloud API |
| Pagamento | Asaas (PIX, boleto, cartão, assinatura) |
| Auth | Auth.js — e-mail com magic link + credenciais |

Dois processos, um repositório: `web` (Next.js) e `worker` (pg-boss), compartilhando `src/core` e o mesmo Prisma Client.

### 3.2 Estrutura de diretórios

```
agente-atendimento/
├── docker-compose.yml           postgres + evolution api (dev)
├── prisma/schema.prisma
├── config/nichos/               seeds versionados em arquivo
│   ├── _template/               esqueleto para clonar
│   ├── clinica-estetica/        reprodução do caso do vídeo
│   ├── petshop/                 prova de genericidade
│   └── advocacia/               nicho sem agenda, prova ferramentas opcionais
├── src/
│   ├── core/                    engine — não conhece Next.js
│   │   ├── tenant/              resolver · config-loader · criptografia
│   │   ├── agent/               loop · prompt · memory · guardrails
│   │   ├── providers/
│   │   │   ├── llm/             interface · anthropic · gemini
│   │   │   ├── stt/             interface · whisper · gemini
│   │   │   └── payment/         interface · asaas
│   │   ├── channel/             interface · evolution · meta
│   │   ├── tools/               registry + implementações
│   │   ├── inbox/               normalizador · debounce
│   │   ├── campaigns/           segmentação · throttle · opt-out
│   │   └── billing/             planos · limites · uso · assinatura
│   ├── worker/                  jobs pg-boss
│   └── app/                     Next.js: painel, webhooks, PWA, admin
└── tests/simulador/             agente-contra-agente + relatório
```

### 3.3 Isolamento de unidades

Cada módulo de `core/` expõe uma interface estreita e não conhece o interior dos outros:

- `ChannelDriver` — `enviarTexto`, `enviarMidia`, `enviarTemplate`, `normalizarWebhook`, `statusInstancia`
- `LLMProvider` — `completar(mensagens, ferramentas)` devolvendo texto ou chamadas de ferramenta
- `Transcriber` — `transcrever(buffer, mimetype)`
- `PaymentProvider` — `criarCobranca`, `criarAssinatura`, `cancelarAssinatura`, `verificarWebhook`
- `Tool` — `nome`, `descricao`, `schema`, `executar(args, ctx)`

Trocar Evolution por Meta, Claude por Gemini ou Asaas por Mercado Pago é escrever um arquivo novo e mudar uma variável de ambiente. Nenhum consumidor muda.

---

## 4. Multi-tenancy

### 4.1 Modelo

Um tenant é uma empresa. A "pasta de nicho" do modelo config-driven vira linhas no banco, editáveis pelo painel — mesma modelagem, com `tenantId` na frente.

As pastas em `config/nichos/` continuam existindo como **seeds**: criar um tenant a partir do template `petshop` popula suas tabelas de configuração. Depois disso, o dono edita pelo painel.

### 4.2 Isolamento

Duas barreiras independentes:

1. **Prisma Client Extension** injeta `tenantId` em todo `where` e todo `create`. Um repositório de dados sem tenant no contexto lança exceção em vez de retornar tudo.
2. **Row-Level Security no Postgres** com `SET LOCAL app.tenant_id` por transação. Se a barreira da aplicação falhar, o banco recusa.

Rotas de super-admin usam uma conexão separada, com papel distinto, que ignora RLS explicitamente.

### 4.3 Segredos

Credenciais de instância (token da Evolution, token da Meta, chave Asaas) são cifradas em repouso com AES-256-GCM usando uma chave-mestra do ambiente. Nunca trafegam para o cliente; o painel exibe só os quatro últimos caracteres.

---

## 5. Configuração de nicho

Seis blocos, versionados em arquivo como seed e editáveis no painel:

| Bloco | Conteúdo | Tabela |
|---|---|---|
| `negocio.yaml` | Nome, endereço, contatos, horário de funcionamento, fuso, integrações ligadas | `ConfigNegocio` |
| `constituicao.md` | Base de conhecimento em prosa — a fonte da verdade | `Constituicao` |
| `servicos.yaml` | Serviço, preço, duração, profissional, dias de atendimento | `Servico` |
| `persona.md` | Objetivo · Tom · Como agir · **O que nunca fazer** | `Persona` |
| `funil.yaml` | Etapas do funil, ordem e critério de avanço | `EtapaFunil` |
| `marca.yaml` | Logo, tokens de cor, fonte do painel | `Marca` |

`negocio.yaml` também declara **quais ferramentas o agente tem**. Um escritório de advocacia desliga `agenda` inteira e o agente deixa de ver essas ferramentas — sem tocar em código.

### 5.1 Nichos de exemplo entregues

- **clinica-estetica** — reproduz o caso do vídeo: agenda, catálogo com preço por região, avaliação gratuita como objetivo
- **petshop** — banho e tosa com porte do animal, produtos, recorrência
- **advocacia** — sem agenda, sem preço público; objetivo é qualificar e encaminhar a um humano

---

## 6. O agente

### 6.1 Ciclo de uma mensagem

```
webhook do canal
  → normaliza para MensagemEntrada (tenant, contato, tipo, conteúdo, mídia)
  → grava e enfileira
  → debounce por contato (janela configurável, padrão 8s)
       junta mensagens picotadas em um único turno
  → resolve mídia
       áudio → Transcriber   → "[áudio do cliente] <transcrição>"
       imagem → visão do LLM → "[imagem do cliente] <descrição>"
  → conversa pausada? grava, notifica o painel e encerra
  → monta prompt
       persona + constituição + catálogo + agora() + memória (N últimas)
  → loop de tool-calling (teto de iterações, padrão 6)
  → guardrail de saída
  → envia · grava · atualiza etapa do funil
```

### 6.2 Prompt

Montado na ordem que o vídeo prescreve, porque é a ordem em que o modelo precisa:

1. **Objetivo** — o que esta conversa precisa alcançar
2. **Ferramentas disponíveis** — nome e descrição de cada uma; é pela descrição que o modelo escolhe
3. **Como agir** — tom, tamanho de mensagem, uma pergunta por vez, tratamento de áudio e imagem
4. **O que nunca fazer** — inventar preço, prometer prazo, oferecer serviço fora do catálogo, mencionar que houve transcrição

Contexto injetado: constituição completa, catálogo de serviços, data e hora no fuso do tenant, memória.

### 6.3 Ferramentas

| Ferramenta | Função | Condição |
|---|---|---|
| `buscar_conhecimento` | Consulta a constituição | sempre |
| `ver_horarios_livres` | Horários realmente livres na agenda | agenda ligada |
| `listar_meus_horarios` | Agendamentos do contato | agenda ligada |
| `criar_agendamento` | Marca, com nome, serviço e telefone | agenda ligada |
| `cancelar_agendamento` | Cancela e libera o horário | agenda ligada |
| `salvar_contato` | Grava nome, interesse e origem no CRM | sempre |
| `atualizar_etapa_funil` | Move o contato de etapa | sempre |
| `gerar_cobranca` | Cria cobrança Asaas e devolve link/QR PIX | pagamento ligado |
| `escalar_humano` | Pausa o agente e notifica o dono | sempre |

### 6.4 Guardrails

O prompt não basta. Antes de enviar, um validador determinístico roda:

1. **Preço inventado** — todo valor monetário na resposta precisa existir no catálogo ou ter vindo de uma `gerar_cobranca` desta conversa. Falhou, regenera uma vez com o erro no contexto; falhou de novo, escala para humano.
2. **Serviço inexistente** — nome de serviço citado precisa constar no catálogo.
3. **Vazamento de rótulo** — a resposta não pode conter `[áudio do cliente]`, `[imagem do cliente]` nem a palavra "transcrição".
4. **Limite de tamanho** — respostas acima do limite do nicho são quebradas em mensagens naturais, não truncadas.

Toda violação é gravada para alimentar o relatório do simulador.

### 6.5 Memória

Janela deslizante das últimas N mensagens por contato — padrão 50, configurável por tenant. Acima disso as mais antigas saem. Um resumo rolante da conversa (gerado a cada 50 mensagens e guardado em `Conversa.resumo`) preserva o essencial sem carregar o histórico inteiro.

---

## 7. Canais

### 7.1 Adaptador

`ChannelDriver` unifica os dois. O tenant escolhe por instância.

| | Evolution API | Meta Cloud API |
|---|---|---|
| Conexão | QR code | Número verificado pela Meta |
| Janela de 24h | não existe | existe |
| Templates | mensagens rápidas locais | templates aprovados pela Meta |
| Custo por mensagem | zero | tarifado por categoria |
| Risco | bloqueio do número | nenhum |
| Subir | minutos | dias de verificação |

### 7.2 Janela de 24h

Só existe no driver Meta. `Conversa.janelaExpiraEm` é atualizada a cada mensagem recebida do contato. O painel mostra o tempo restante na conversa. Expirada, o campo de texto livre desabilita e sobra o seletor de template — exatamente a limitação que o painel do dono existe para contornar.

No driver Evolution o campo nunca desabilita.

### 7.3 Templates

`Template` guarda nome, categoria (`UTILITY` · `MARKETING` · `AUTHENTICATION`), idioma, corpo com variáveis `{{1}}`, status e id na Meta.

No painel: criar → submeter à Meta → job de polling acompanha aprovação → disponível para uso. Ao enviar, o sistema tenta **preencher as variáveis automaticamente** a partir da conversa e do agendamento do contato; o que não conseguir extrair fica editável à mão antes do envio.

No driver Evolution o mesmo objeto vira "mensagem rápida": sem submissão, sem aprovação, disponível na hora.

---

## 8. Painel do Dono

### 8.1 Abas

| Aba | Conteúdo |
|---|---|
| **Conversas** | Inbox estilo WhatsApp Web · alternância Agente ⇄ Manual por conversa · não-lidas · contador da janela de 24h · templates e mensagens rápidas · áudio e imagem inline com a transcrição ao lado |
| **Funil** | Colunas vindas de `EtapaFunil`, arrastáveis · contagem e taxa de conversão entre etapas · clique abre a conversa |
| **CRM** | Tabela de contatos · filtro por etapa, interesse, período e tag · seleção em massa → campanha · exportar CSV |
| **Campanhas** | Criar, agendar, acompanhar · segmento, mensagem ou template, janela horária, throttle · progresso e falhas ao vivo |
| **Agenda** | Dia e semana · criar e cancelar direto · o que o agente marcou aparece aqui · sincronização opcional com Google Calendar |
| **Ajustes** | Editar constituição, catálogo, persona, etapas do funil, marca · ligar e desligar ferramentas · **sandbox** para conversar com o agente sem WhatsApp conectado |
| **Cobrança** | Plano, consumo do mês, faturas, forma de pagamento |

### 8.2 Área de super-admin

Rota separada para o operador da plataforma: tenants, planos, consumo agregado, inadimplência, saúde das instâncias, logs de erro por tenant.

### 8.3 Sistema visual — Mind Sculptor

Estilo **Data-Dense Dashboard** — grade densa, padding contido, tabelas e KPIs em primeiro plano, ornamento zero — vestido com a identidade Mind Sculptor.

A paleta sai da logo: as peças superiores do quebra-cabeça são âmbar, a base e o rosto puxam para o vermelho, tudo sobre preto puro. Essa progressão vira a rampa do produto inteiro.

| Token | Valor | Papel |
|---|---|---|
| `--brand-300` | `#FFC24A` | brilho das peças |
| `--brand-400` | `#FFA51C` | âmbar do topo |
| `--brand-500` | `#FF7A1A` | laranja-núcleo da marca |
| `--brand-600` | `#F04310` | vermelho-laranja |
| `--brand-700` | `#C42D08` | sombra · ação no tema claro |
| `--ink-950` | `#000000` | o preto da logo |

**O tema claro não pode usar o laranja da logo em texto.** `#FF7A1A` sobre branco rende ~2.6:1 e reprova o mínimo de 4.5:1 da WCAG. Então o tema claro usa a ponta profunda da mesma rampa (`#C42D08`, 5.6:1) em tudo que carrega texto, e reserva o laranja vivo para o que não precisa ser lido: ícones, bordas, séries de gráfico.

No tema escuro o problema desaparece — `#FF8A2B` sobre preto dá 8.9:1. **O escuro é o habitat nativo da marca** e é o padrão do painel.

Tipografia: **Fira Sans** na interface, **Fira Code** em colunas numéricas, horários, telefones e identificadores — números tabulares evitam as colunas dançarem a cada atualização ao vivo. A serifada display da logo fica só na logo.

Tokens completos em `assets/brand/tokens.css`; guia visual navegável em `docs/brand.html`.

`marca.yaml` sobrescreve `--color-primary` e a logo por tenant — o white-label é troca de variável CSS, não fork de tema. Claro e escuro desenhados juntos, contraste verificado em cada um separadamente.

Não negociável: contraste 4.5:1 no texto, alvos de toque de 44px, foco visível no teclado, ícones Lucide (nunca emoji), `prefers-reduced-motion` respeitado, transições de 150–300ms, listas acima de 50 itens virtualizadas.

### 8.4 PWA

Manifest, service worker e Web Push (VAPID) para nova mensagem e conversa escalada. No mobile o inbox vira duas telas — lista, depois conversa — com navegação inferior de cinco itens e o resto em "Mais". Safe-area respeitada, sem scroll horizontal em 375px.

---

## 9. Campanhas e disparo em massa

### 9.1 Motor

Segmento montado no CRM → `Campanha` → job gera um `EnvioCampanha` por contato → worker consome respeitando:

- **Throttle** — mensagens por minuto configurável, com jitter aleatório para não formar padrão de robô
- **Janela horária** — só dispara dentro do horário permitido do tenant (padrão 9h–20h)
- **Cota diária** por instância
- **Opt-out** — `SAIR` ou `PARAR` marca `Contato.optOut` e o exclui de toda campanha futura; rodapé com a instrução é anexado automaticamente no driver Evolution

### 9.2 Risco por driver

No driver Evolution, disparo em massa é o caminho mais curto para o número ser bloqueado. O painel exibe o aviso ao criar a campanha e a cota padrão nasce conservadora. No driver Meta o mesmo motor usa template aprovado e opera dentro das regras da plataforma.

---

## 10. Cobrança

### 10.1 Assinatura da plataforma

`Plano` define limites: instâncias, mensagens por mês, usuários, campanhas por mês. `Assinatura` espelha a assinatura Asaas. `UsoMensal` acumula o consumo.

Trial de 7 dias sem cartão. Em 80% do limite, aviso no painel. Em 100%, o agente para de responder e o dono é notificado — as conversas continuam chegando e ficam visíveis para atendimento manual, porque cortar a visibilidade puniria o cliente final. Webhook da Asaas atualiza o status; inadimplência suspende após período de tolerância.

### 10.2 Link de pagamento na conversa

`gerar_cobranca(valor, descricao, metodo)` cria a cobrança na Asaas e devolve link e QR Code PIX, que o agente manda na conversa. O webhook de confirmação marca como paga, avança a etapa do funil e notifica o dono.

O valor precisa vir do catálogo ou de uma regra do nicho — o guardrail de preço inventado se aplica aqui também.

---

## 11. Testes

### 11.1 Simulador agente-contra-agente

O método que o vídeo usa para sair de 17 erros em 30 mensagens e chegar a zero em 100 conversas:

1. Um gerador cria N personas de cliente a partir do nicho — o apressado, o que só pergunta preço, o que manda áudio confuso, o que muda de ideia, o que tenta agendar fora do horário
2. Cada persona conversa com o agente até encerrar ou atingir o teto de turnos
3. Um juiz LLM avalia cada resposta contra as regras da persona do tenant, e os guardrails determinísticos entram como avaliação objetiva
4. Sai um relatório em Markdown e JSON: taxa de violação por regra, trecho ofensor, conversa de origem

`npm run simular -- --nicho petshop --conversas 100`

### 11.2 Demais níveis

- **Unitário** — guardrails, debounce, throttle, segmentação, cálculo de horários livres, montagem de prompt
- **Integração** — drivers de canal contra servidor falso, webhooks Asaas, isolamento de tenant (um tenant tentando ler outro precisa falhar)
- **E2E** — Playwright nos fluxos do painel: assumir e devolver conversa, criar campanha, editar catálogo

---

## 12. Erros e observabilidade

| Falha | Resposta |
|---|---|
| LLM fora do ar | Retenta com backoff; persistindo, cai no provider alternativo; falhando, escala para humano |
| Transcrição falha | Agente pede gentilmente que escreva |
| Canal fora do ar | Mensagem fica em fila e reenvia; painel mostra a instância como desconectada |
| Webhook duplicado | Idempotência por id externo da mensagem |
| Loop de ferramentas | Teto de iterações; estourou, escala |
| Asaas fora do ar | Cobrança em fila; agente avisa que o link chega em instantes |

Logs estruturados com `tenantId` e `conversaId` em toda linha. Cada turno do agente grava um `TraceAgente`: prompt, ferramentas chamadas, tokens, latência, violações. É o que torna a otimização possível em vez de adivinhação.

---

## 13. Fora de escopo

Não entram nesta entrega: app nativo em loja, Instagram e Telegram (a interface de canal já os acomoda depois), relatórios de BI além do funil, gravação de chamadas, agente de voz, marketplace de nichos.

---

## 14. Decomposição em fases

O sistema descrito acima é grande demais para um único plano de implementação — são sete subsistemas que podem ser construídos e validados de forma independente. Cada fase recebe seu próprio plano e termina em algo demonstrável.

A ordem não é arbitrária: cada fase depende só das anteriores, e as fundações mais caras de mudar vêm primeiro.

### Fase 1 — Fundação e cérebro do agente

Prisma + Postgres, modelagem multi-tenant com as duas barreiras de isolamento, carregador de configuração de nicho, os quatro pilares (`LLMProvider`, prompt, `tools`, memória), guardrails, e o **sandbox** no navegador.

Entrega demonstrável: conversar com o agente da clínica pela web, sem WhatsApp, e ver as ferramentas sendo escolhidas.
Por que primeiro: é o núcleo do produto e a modelagem de tenant é a decisão mais cara de reverter.

### Fase 2 — Canal e conversas reais

`ChannelDriver`, driver Evolution, normalizador de webhook, debounce de mensagens picotadas, transcrição de áudio, visão para imagem, persistência de conversas.

Entrega: o agente atende de verdade em um número de WhatsApp, entendendo áudio e foto.

### Fase 3 — Painel do Dono, núcleo

Auth, layout, sistema de tokens white-label, aba Conversas com alternância Agente ⇄ Manual, aba Agenda, aba Ajustes com editor de configuração.

Entrega: o dono opera o atendimento pelo painel.

### Fase 4 — CRM e funil

Etapas configuráveis, ferramentas de funil no agente, aba Funil, aba CRM com filtros e exportação, sincronização opcional com Google Sheets e Calendar.

Entrega: o dono enxerga onde cada cliente parou.

### Fase 5 — Simulador e endurecimento

Gerador de personas, motor de conversa agente-contra-agente, juiz, relatório. Rodar o ciclo até zerar as violações nos três nichos de exemplo.

Entrega: prova numérica de que o agente não erra.
Por que aqui: precisa das fases anteriores para ter o que testar, e precisa vir antes de colocar dinheiro e disparo em massa em cima.

### Fase 6 — Driver Meta, templates e janela de 24h

Segundo driver de canal, ciclo de submissão e aprovação de templates, contador de janela no painel, mensagens rápidas como equivalente na Evolution.

Entrega: o tenant escolhe canal oficial ou não-oficial sem trocar nada mais.

### Fase 7 — Campanhas

Segmentação a partir do CRM, motor de disparo com throttle, janela horária, cota e opt-out, aba Campanhas com acompanhamento ao vivo.

### Fase 8 — Cobrança

Asaas, planos e limites, assinatura e trial, medição de uso, bloqueio gradual, ferramenta `gerar_cobranca`, aba Cobrança, área de super-admin.

### Fase 9 — PWA

Manifest, service worker, Web Push, layout mobile do inbox, navegação inferior.

### Dependências

```
1 ──> 2 ──> 3 ──> 4 ──> 5 ──> 6 ──> 7
                  └────────────────> 8
                        3 ──────────> 9
```

As fases 7, 8 e 9 são independentes entre si e podem trocar de ordem conforme a urgência.
