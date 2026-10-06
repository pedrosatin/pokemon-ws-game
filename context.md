> Atualizado: 2026-09-26 — Fatia 3: reconnect 60s, PWA polish, testes, post #37.
> Atualizado: 2026-09-26 — Fatia 2: Super Trunfo jogável + seed gen1 + Query prefetch.
> Atualizado: 2026-09-26 — PWA/mobile MUST, Workers Free, scaffold fatia 1.
> Atualizado: 2026-09-25 — brief de produto + pesquisa competitiva (portfólio/aprendizado).

# Super Trunfo Pokémon via WebSocket

Demo multiplayer no browser para aprender e publicar sobre WebSockets. O jogo usa stats canônicos da PokéAPI num confronto Super Trunfo. O artigo fecha a issue [`satinp-portfolio#37`](https://github.com/pedrosatin/satinp-portfolio/issues/37).

---

## 1. Origem e objetivo de aprendizado

**Fontes**
- TODOS (`pedrosatin/todos`): "Chat ou jogo simples com WebSockets — pokemon, super trunfo ou algo parecido".
- Issue [`satinp-portfolio#37`](https://github.com/pedrosatin/satinp-portfolio/issues/37): "Write about web sockets - creating a chat or a simple game (pokemon, super trunfo dota?)". Corpo referencia o tutorial Ably [WebSockets with React](https://ably.com/blog/websockets-react-tutorial) (cursors, reconnect, presence).
- Decisão de arquitetura local: TanStack Query cacheia PokéAPI (`staleTime: Infinity`) e o WebSocket carrega só IDs + ações.

**Objetivo**
Shipar uma demo jogável 1v1 e um post técnico que mostre:
1. Sala stateful com Durable Object e eventos tipados.
2. Separação entre dados estáticos (Query) e estado transitório (WS).
3. Reconnect com recuperação de estado.
4. Funil de produto + métricas de infra WS.

O post responde a #37 com artefato público, não só texto.

---

## 2. Posicionamento do produto-demo

**O que é.** Fan demo educacional. Dois jogadores entram numa sala por código, recebem decks de Pokémon e disputam Super Trunfo comparando um stat por rodada. Sem conta obrigatória, sem ranking persistente no MVP.

**Para quem (ICP).** Desenvolvedores que leem o portfólio e o blog. Critério de sucesso do jogador secundário: completar uma partida em &lt; 3 minutos e entender o desenho WS no post.

**Posicionamento.** "Sala DO + payloads magros + cache infinito da PokéAPI". Competidores de batalha completa (Showdown) resolvem outro problema. Clones de Top Trumps single-player resolvem só UI. O white space é multiplayer em edge Cloudflare com contrato de eventos explícito e analytics nomeados, feito para explicar em artigo.

**Framing IP.** Projeto fan/educacional. Dados via PokéAPI. Sem afiliação a Nintendo, Game Freak, Creatures ou The Pokémon Company. Preferir o nome "Super Trunfo de stats" a "batalha Pokémon". Disclaimer visível no lobby e no rodapé.

---

## 3. Mecânica recomendada para o MVP

### Decisão: Super Trunfo de stats (MUST do MVP)

Cada jogador recebe N cartas (default 5). Em cada rodada o dono do turno escolhe um atributo da carta do topo. O servidor compara os valores canônicos e atribui ponto (ou a carta) ao vencedor. Empate empilha ou empata a rodada conforme regra fixa. Vence quem fizer mais pontos em N rodadas ou quem ficar com todas as cartas no modo captura.

**Stats no MVP:** `hp`, `attack`, `defense`, `special-attack`, `special-defense`, `speed`. Height e weight ficam no SHOULD (normalização de unidade e UX de leitura).

**Por que esta mecânica**
- Superfície de regras pequena: um choose → compare → score. Fácil de demoar em live ou GIF do post.
- Eventos WS naturais e curtos. O post explica o protocolo sem simular type chart.
- Prefetch TanStack Query mapeia 1:1 com a pilha de IDs.
- Menor risco de parecer um simulador oficial do que um 3v3 com golpes e tipos.
- A própria issue #37 cita "super trunfo" ao lado de Pokémon.

### Alternativa adiada: 3v3 simplificado (SHOULD / COULD)

Draft de 3 Pokémon, turnos com golpe ou troca, prioridade por Speed, multiplicadores de tipo. Fica no SHOULD (protótipo pós-MVP) ou COULD (v2 se o post pedir profundidade de estado).

**Por que não no MVP.** Pokémon Showdown prova o custo: motor de eventos genérico, rooms, login, mods por geração. Mesmo um 3v3 "casual" exige tabela de tipos, validação de ações simultâneas e UI de HP/status. Isso atrasa o ship e dilui a tese do artigo (WS + Query), sem ganho proporcional para portfólio.

---

## 4. Loop de jogo

```
Lobby → Criar/Entrar sala (código 8 chars)
     → Ready (2/2)
     → Deal (servidor sorteia IDs, envia decks)
     → Prefetch Query no cliente
     → Rodadas (turn_player escolhe stat → server resolve → ROUND_RESULT)
     → Match end (MATCH_COMPLETED)
     → Rematch opcional ou volta ao lobby
```

**Detalhes operacionais**
- Matchmaking no MVP = código compartilhado (sem fila pública).
- Timer de escolha: 15s. Timeout escolhe o maior stat da carta ativa (bot local no servidor).
- Modo pontuação: melhor de N rodadas (N = tamanho do deck). Mais simples de explicar e de instrumentar do que captura total de baralho.
- Host cria a sala. Qualquer um com o código entra até `maxPlayers = 2`.
- Estado autoritativo só no Durable Object da sala.

---

## 5. Contrato de eventos WS

Envelope comum:

```ts
type Envelope<T extends string, P> = {
  v: 1;
  type: T;
  ts: number;          // epoch ms (server)
  roomId: string;
  seq?: number;        // seq monotônico do server (snapshot/resync)
  payload: P;
};
```

### Cliente → servidor

| type | payload mínimo | notas |
| --- | --- | --- |
| `JOIN_ROOM` | `{ code: string, displayName: string, clientId: string }` | `clientId` estável em `sessionStorage` para reconnect |
| `READY` | `{ ready: boolean }` | |
| `SELECT_STAT` | `{ roundId: string, stat: StatKey }` | só o `turnPlayer`; server rejeita fora da vez |
| `REQUEST_SYNC` | `{ lastSeq: number }` | após reconnect |
| `LEAVE` | `{}` | |
| `REMATCH` | `{}` | ambos precisam confirmar |

`StatKey = "hp" \| "attack" \| "defense" \| "special-attack" \| "special-defense" \| "speed"`

### Servidor → cliente(s)

| type | payload mínimo | notas |
| --- | --- | --- |
| `ROOM_STATE` | `{ phase, players[], code, youAre }` | snapshot; também resposta a `REQUEST_SYNC` |
| `PLAYER_JOINED` | `{ playerId, displayName }` | |
| `PLAYER_LEFT` | `{ playerId, reason }` | |
| `DEAL` | `{ roundCount, yourDeck: number[], opponentDeckCount: number }` | IDs só; nunca sprites/stats no fio |
| `ROUND_START` | `{ roundId, roundIndex, yourCardId, turnPlayerId, deadlineMs }` | oponente não vê o cardId do rival até o resultado (opção A) **ou** vê o card virado (opção B). MVP = opção A (só revela no result) |
| `STAT_SELECTED` | `{ roundId, playerId, stat }` | broadcast após aceite |
| `ROUND_RESULT` | `{ roundId, stat, p1: { cardId, value }, p2: { cardId, value }, winnerId \| null, scores }` | |
| `MATCH_COMPLETED` | `{ winnerId \| null, scores, reason }` | `reason`: `score` \| `disconnect` \| `forfeit` |
| `ERROR` | `{ code, message }` | `NOT_YOUR_TURN`, `ROOM_FULL`, `INVALID_STAT`, … |
| `PONG` | `{ pingId }` | heartbeat |

**Regras de autoridade**
- Cliente nunca envia valores de stat. Server resolve com tabela local (seed da PokéAPI ou fetch server-side no deal).
- `SELECT_STAT` inválido ou fora de fase → `ERROR`, estado inalterado.
- Reconnect: cliente manda `JOIN_ROOM` com mesmo `clientId` + `REQUEST_SYNC`; server reenvia `ROOM_STATE` com `seq` atual e o último `ROUND_*` relevante.

---

## 6. Papel do TanStack Query versus estado realtime

| Camada | Responsável | Exemplos |
| --- | --- | --- |
| TanStack Query | Dados imutáveis da espécie | nome, sprites, base stats, types |
| WebSocket / DO | Estado de sessão | fase, turnos, scores, deadlines, presença |

**Query**
- `usePokemon(id)` com `staleTime: Infinity`, `gcTime` longo; persist opcional via `persistQueryClient`.
- No `DEAL`, `queryClient.prefetchQuery` para todos os IDs do deck (e, se a UX revelar o oponente cedo, para os IDs conhecidos).
- WS envia `25`; a UI lê `data.sprites…` e `data.stats` do cache. Se o cache missar, a carta mostra skeleton até o fetch.

**Realtime**
- Máquina de estados da sala no DO.
- Cronômetro e resolução de rodada só no server.
- Presence = lista `players[]` em `ROOM_STATE`.

Tese do post: o fio WS fica legível porque o payload é ID + ação; a Query absorve o volume da PokéAPI.

---

## 7. Pesquisa competitiva

| Comp | Tipo | Relevância | Lição para este demo |
| --- | --- | --- | --- |
| [Pokémon Showdown](https://pokemonshowdown.com/) | Simulador competitivo completo | Foil de complexidade | Rooms + SockJS + motor enorme. Fora do escopo de um post de WS. |
| [PokeMatch](https://github.com/leontutu/PokeMatch) | Top Trumps multiplayer (React + Node + WS) | Comp direto de mecânica | Mesmo JTBD; stack clássica Node. Diferencial nosso: edge CF + Query + analytics + artigo. |
| [lukecherry Top Trumps](https://lukecherry.com/pokemon-toptrumps/) | Single-player browser | Convenção de UX de carta/stat | Loop claro sem multiplayer. Confirma apelo visual do Super Trunfo. |
| [PartyKit / PartyServer](https://docs.partykit.io/) (sobre DO) | Rooms WS em Durable Objects | Comp de arquitetura | Modelo room-id → instância stateful. Preferir Workers + DO nativos (ou `partyserver`) no mesmo edge. |
| [Ably React WS tutorial](https://ably.com/blog/websockets-react-tutorial) | Tutorial (ref da #37) | Escopo do aprendizado | Reconnect, presence, onde colocar o socket no React. Nosso post troca cursors por regras de jogo autoritativas. |
| CF Doom / hellgate-ws / cid-game | Demos DO + WS | Prova de stack | Código curto de sala + share link é o padrão de demos Cloudflare. |

**White space.** Multiplayer Super Trunfo Pokémon com (1) contrato tipado publicado, (2) TanStack Query como peça explícita da arquitetura, (3) analytics de funil + WS, (4) post amarrado à #37. PokeMatch cobre a mecânica sem esse pacote de aprendizado.

---

## 8. Requisitos MUST / SHOULD / COULD e não-objetivos

### MUST
- Super Trunfo 1v1 por código de sala.
- Servidor autoritativo (validação de turno, stats, scores).
- Contrato WS da seção 5 implementado (subset suficiente para jogar ponta a ponta).
- TanStack Query com `staleTime: Infinity` + prefetch no `DEAL`.
- Deploy Cloudflare Workers com static assets (SPA) + Durable Object por sala — **plano Free**.
- **PWA instalável** (`manifest` + service worker): `display: standalone`, ícones 192/512, theme color, safe-areas; jogável no celular em tela cheia.
- Shell PWA em cache; partida **sempre online** (WebSocket). Offline só mostra aviso no lobby.
- Disclaimer fan/educacional + créditos PokéAPI.
- Analytics: `ws_connected`, `round_started`, `stat_selected`, `match_completed`, `reconnect_recovered` (mais funil abaixo).
- Mobile-first jogável (criar/entrar, escolher stat, ver resultado; alvos ≥44px).
- Reconnect com `clientId` + `REQUEST_SYNC` recuperando a partida em andamento.
- Demo pública + rascunho do post da #37.

### SHOULD
- Timer visual + auto-pick no timeout.
- Rematch na mesma sala.
- Persistência leve do cache Query.
- Height/weight como stats opcionais.
- Modo spectate read-only (terceiro na sala só recebe broadcasts).
- Seed local dos stats no Worker (menos dependência de PokéAPI em runtime de partida).
- Testes de máquina de estados da sala.

### COULD
- Fila rápida (matchmaking sem código).
- Bot oponente para demo single-tab.
- 3v3 simplificado.
- Replay/`seq` history para o post.
- Áudio SFX.
- i18n EN.

### Não-objetivos
- Contas, ladder, ELO, chat livre.
- Simulação fiel a gerações Showdown.
- Monetização, ads, loot.
- Assets oficiais empacotados no repo (sprites vêm da PokéAPI em runtime ou CDN público documentado).
- App nativo (Store).
- PWA offline completo (partida sem rede).
- Push notifications / Background Sync pagos.
- Anti-cheat avançado além de autoridade de server.

---

## 8.1 Custo zero (Workers Free)

| Recurso | Free plan (ordem de grandeza) | Uso neste projeto |
| --- | --- | --- |
| Static assets | Ilimitado | UI/PWA |
| Worker requests | 100k/dia | `/api/*`, upgrade WS |
| Durable Objects | 100k req/dia + 13k GB-s/dia; SQLite only | 1 DO por sala; hibernation WS |
| Web Analytics | Grátis | Visitas |
| PokéAPI | Grátis | Stats/sprites |

Cabem partidas casuais e demo de portfólio. Estouro diário → erro até 00:00 UTC. Workers Paid ($5/mês) só se a conta inteira precisar de folga — **não é requisito do MVP**.

---

## 9. UX

**Mobile-first sala**
- Tela 1: nickname + Criar / Entrar (código em monospace, copy link `?room=`).
- Tela 2: lobby com 2 slots, toggle Ready, indicador WS (conectado / reconectando).
- Tela 3: carta própria grande; stats como botões; placar; countdown; carta rival oculta até `ROUND_RESULT`.
- Tela 4: placar final + Rematch / Nova sala.

**Spectator.** SHOULD: join com `role: spectator` se a sala já tem 2 players; recebe os mesmos eventos de resultado, sem `SELECT_STAT`.

**Reconnect.** Banner "Reconectando…"; ao recuperar, `reconnect_recovered` e UI hidrata do `ROOM_STATE`. Se o DO já encerrou por forfeit (timeout de ausência &gt; 60s), mostra resultado e CTA de nova sala.

**Latência esperada.** Escolha de stat é turn-based; RTT de 100 a 300 ms é aceitável. Feedback otimista só no highlight do botão; placar só após `ROUND_RESULT`.

**Demoability.** Dois perfis de browser ou dois devices; link da sala no clipboard; partida completa &lt; 3 min com deck de 5.

---

## 10. Stack Cloudflare-first + analytics

### Stack
| Camada | Escolha | Alternativa |
| --- | --- | --- |
| UI | React 19 + Vite 8 + TypeScript + Tailwind 4 + TanStack Query v5 | (nenhuma no MVP) |
| PWA | `vite-plugin-pwa` (manifest + Workbox) | (nenhuma no MVP) |
| Hosting | Cloudflare Workers + Assets (SPA) via `@cloudflare/vite-plugin` | Pages clássico |
| Realtime | Worker + Durable Object `GameRoom` por código (Hibernation WS) | PartyKit / `partyserver` |
| Dados espécie | PokéAPI + cache Query; seed JSON no Worker no SHOULD | (nenhuma no MVP) |
| Analytics | Cloudflare Web Analytics + eventos custom (Analytics Engine no SHOULD se couber no free) | PostHog self-serve |

Cliente WS: `WebSocket` nativo em `/ws?room=CODE`. Sem Socket.IO. Protocolo em `shared/protocol.ts`.

### Scaffold (2026-09-26)
- Fatia 1 no repo: lobby PWA, `POST /api/room`, DO hibernável, join/ready/sync.
- Pacotes pinados nas majors atuais (React 19, Vite 8, Query 5, Wrangler 4, Tailwind 4). Rodar `pnpm audit` antes de cada release.

### Eventos de analytics (produto + infra)

**Infra / WS**
- `ws_connected` `{ roomId, clientId, isReconnect }`
- `ws_disconnected` `{ roomId, code, reason }`
- `reconnect_recovered` `{ roomId, lastSeq, gap }`
- `ws_error` `{ code }`

**Funil de jogo**
- `lobby_created` / `lobby_joined`
- `ready_toggled`
- `match_started` (após `DEAL`)
- `round_started` `{ roundIndex }`
- `stat_selected` `{ stat }` (sem cardId se quiser privacidade)
- `round_resolved` `{ winner: self\|opp\|draw }`
- `match_completed` `{ winner: self\|opp\|draw, rounds, durationMs }`
- `rematch_accepted`

Instrumentar no Worker (fonte da verdade) e espelhar no client só o que ajudar UX. O post usa esses nomes como seção de observabilidade.

---

## 11. Riscos e mitigações

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| IP Pokémon (Nintendo / TPC) | Takedown ou atrito no portfólio | Framing fan/educacional; Super Trunfo de stats; disclaimer; sem monetização; sem assets oficiais no git; nomes/stats via PokéAPI; evitar "battle simulator". Se houver pressão, trocar skin para "monster stats" genérico mantendo o protocolo. |
| Cheating trivial | Stats forjados no client | Server autoritativo; cliente manda só `stat`; valores vêm do seed server-side. |
| Latência / tab background | Timeout injusto | Deadline server-side; grace de reconnect 60s; auto-pick no timeout de escolha. |
| PokéAPI downtime | Deal ou UI quebrada | Prefetch + cache persistente; SHOULD: seed JSON no Worker no cold start da sala. |
| DO cold start / hibernation | Delay no primeiro evento | Mensagem "abrindo sala…"; persistir estado mínimo em `storage` do DO. |
| Escopo 3v3 | Não shipar | Mecânica primaria já decidida; 3v3 só COULD. |

---

## 12. Métricas de sucesso

**Demo**
- Partida 1v1 completa por dois clients distintos.
- Reconnect no meio da rodada recupera estado (`reconnect_recovered` &gt; 0 em teste).
- Lighthouse / uso mobile: escolher stat sem zoom horizontal.
- Tempo mediano de partida (deck 5) entre 90s e 180s.

**Artigo (#37)**
- Post publicado no portfólio/blog com H2s da seção 15.
- Issue #37 referenciada e fechável com link da demo + post.
- Diagrama Query vs WS e tabela do contrato de eventos no corpo do texto.
- Mencionar os cinco eventos de analytics obrigatórios com um exemplo de leitura.

**Kill criteria**
- Se em duas fatias ainda não houver `SELECT_STAT` → `ROUND_RESULT` autoritativo no DO, cortar UI polish e shipar wireframe jogável.
- Se risco IP bloquear publicação com nomes Pokémon, publicar o post com protocolo + demo "generic trunfo" e manter o código de integração PokéAPI atrás de flag.

---

## 13. Roadmap em 3 fatias

**Fatia 1. Sala morta + protocolo vivo** ✅ scaffold  
DO com `JOIN_ROOM` / `ROOM_STATE` / ready. Workers+Assets com lobby PWA mobile-first e indicador de conexão. Sem cartas ainda.

**Fatia 2. Super Trunfo jogável** ✅  
`DEAL`, `ROUND_START`, `SELECT_STAT`, `ROUND_RESULT`, `MATCH_COMPLETED`. Seed gen1 no Worker. Query + prefetch. Placar. Analytics estruturados no Worker. Rematch.

**Fatia 3. Endurecer + escrever** ✅  
Reconnect com grace 60s + `REQUEST_SYNC` + alarm multiplexado. Banners PWA/offline/install. Disclaimer IP reforçado. Testes Vitest em `shared/game`. Posts em `satinp-portfolio` (pt-br/en) e `docs/POST-*.md`.

---

## 14. Perguntas em aberto

1. Deck size default: 5 ou 7?
2. Revelação do card rival: só no result (MVP proposto) ou virado no `ROUND_START`?
3. Empate de stat: ponto pra ninguém ou re-roll da mesma carta?
4. Spectator no MVP ou só SHOULD?
5. Analytics Engine da Cloudflare basta para o post, ou PostHog desde a fatia 2?
6. Nome público do projeto (evitar trademark "Pokémon" no título do domínio)?
7. Seed de IDs: gens 1 só (nostalgia + payload menor) ou dex completo?
8. Rematch reseta decks com shuffle novo ou reusa o mesmo deal?

Máximo de oito. Decidir nas fatias 1 e 2 com defaults se ninguém responder: deck 5, reveal no result, empate = nenhum ponto, sem spectator, Analytics Engine, título "Super Trunfo de Stats (fan demo)", gen 1, rematch com shuffle novo.

---

## 15. Próximos passos técnicos e outline do post

### Próximos passos técnicos
1. Scaffold monorepo: `apps/web` (Pages) + `apps/worker` (DO room).
2. Tipar o envelope e os eventos da seção 5 num pacote `shared`.
3. Implementar máquina de estados `lobby → dealing → round → result → end`.
4. Ligar `usePokemon` + prefetch no handler de `DEAL`.
5. Emitir os analytics MUST no Worker.
6. Subir preview Cloudflare e rodar partida em dois browsers.
7. Escrever o post com a demo no ar.

### Outline do post técnico (H2s sugeridos)

1. Por que um jogo (e não só um chat) para aprender WebSockets  
2. Super Trunfo de stats: regras mínimas, eventos máximos de aprendizado  
3. Arquitetura: Pages + Worker + Durable Object por sala  
4. Contrato de eventos (tabela client↔server)  
5. TanStack Query com `staleTime: Infinity` e prefetch da pilha  
6. O que nunca vai no fio WS  
7. Reconnect com `clientId` e `REQUEST_SYNC`  
8. Analytics de funil e de infra (`ws_connected` … `reconnect_recovered`)  
9. Limites: IP fan-demo, cheating trivial, PokéAPI  
10. O que viria num 3v3 e por que ficou de fora  
11. Links: demo, repo, issue #37  

Referência de leitura cruzada: tutorial Ably citado na #37 (hooks React, presence, reconnect) contrastado com servidor autoritativo de jogo no edge.

---

## Apêndice. Defaults travados para o MVP

| Item | Default |
| --- | --- |
| Mecânica | Super Trunfo de stats |
| Players | 2 |
| Deck | 5 IDs, gen 1 |
| Stats | 6 base stats PokéAPI |
| Vitória | Mais pontos após 5 rodadas |
| Timer | 15s + auto maior stat |
| Reveal rival | No `ROUND_RESULT` |
| Stack realtime | CF Worker + Durable Object |
| Alternativa realtime | PartyKit / partyserver |
| Cache | TanStack Query, `staleTime: Infinity` |
