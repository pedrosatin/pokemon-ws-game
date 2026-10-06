# Super Trunfo de Stats

Fan demo educacional: Super Trunfo 1v1 no browser/PWA, com WebSocket em Cloudflare Durable Objects e cache de dados estáticos via TanStack Query.

Sem afiliação à Nintendo, Game Freak, Creatures ou The Pokémon Company. Dados via [PokéAPI](https://pokeapi.co/).

Criado por [@pedrosatin](https://github.com/pedrosatin).

## Stack

- React 19 + Vite 8 + TypeScript + Tailwind 4
- PWA (`vite-plugin-pwa`) instalável no celular
- Cloudflare Workers (static assets) + Durable Object hibernável por sala
- TanStack Query (`staleTime: Infinity`) + prefetch no `DEAL`
- Seed gen 1 autoritativo em `shared/gen1-stats.ts`

Roda no **Workers Free**. Detalhes de produto em [`context.md`](./context.md).

**Demo:** https://pokemon-ws-game.satinp-dev.workers.dev  
**Repo:** https://github.com/pedrosatin/pokemon-ws-game

## Desenvolvimento

```bash
pnpm install
pnpm dev
```

Scripts:

| Comando | Função |
| --- | --- |
| `pnpm test` | Vitest (comparação de stats / deal) |
| `pnpm build` | typecheck + build SPA + Worker |
| `pnpm preview` | preview no runtime Workers |
| `pnpm deploy` | publica em `*.workers.dev` |
| `pnpm cf-typegen` | regenera tipos do Wrangler |
| `pnpm audit` | auditoria de deps de produção |

## Como jogar

1. Crie uma sala e copie o link.
2. Entre com outro dispositivo ou aba.
3. Os dois marcam **Estou pronto**.
4. Escolha stats por 5 rodadas. Timeout de 15s auto-escolhe o maior atributo.
5. Se a conexão cair, o servidor espera 60s antes do forfeit.

## Documentação

- Produto: [`context.md`](./context.md)
- Post (PT): [`docs/POST-pt-br.md`](./docs/POST-pt-br.md)
- Post (EN): [`docs/POST-en.md`](./docs/POST-en.md)

## Contribuição

Encontrou um bug ou tem uma ideia? Abra uma issue em https://github.com/pedrosatin/pokemon-ws-game/issues.

## Limites de salas

Um Durable Object de diretório (`RoomDirectory`, binding `ROOM_DIRECTORY`)
confirma que a sala existe antes de abrir o objeto do jogo. Em produção, o IP
vem do cabeçalho `CF-Connecting-IP`. IPv4 conta por endereço e IPv6 conta pelo
prefixo `/64`.

- Criação: 5 salas por endereço por minuto e 250 salas por hora no serviço.
- Salas ativas: no máximo 500, o que corresponde a 250 por hora com validade de
  duas horas.
- Entrada: 20 tentativas por endereço por minuto. Código desconhecido recebe
  404 sem abrir a sala.
- O diretório guarda até 2000 registros de cota. Com a tabela cheia, o registro
  que expira primeiro é descartado; entrar em uma sala existente nunca é
  recusado por falta de espaço.
- As salas expiram duas horas após a criação. O `alarm` do Durable Object avisa
  os jogadores com `ROOM_EXPIRED`, fecha os sockets e apaga o estado.
- Cada conexão aceita até 30 mensagens em dez segundos e 4096 caracteres por
  mensagem, com validação de payload e do código da sala.

Todas as criações e entradas passam por um único objeto (`getByName("rooms")`).
Para o volume do jogo isso basta, mas é um ponto único de contenção. A cota
global reduz a disponibilidade sob ataque distribuído e pode ser ajustada em
`worker/room-directory.ts` conforme o uso observado.

### Implantação

O deploy (`pnpm run deploy`) aplica a migração `v2`, que cria a classe
`RoomDirectory`. Salas criadas antes dela não entram no diretório e precisam ser
recriadas. Depois que a `v2` estiver aplicada, um `wrangler rollback` para uma
versão sem `RoomDirectory` tende a ser recusado; reverta com um novo deploy.

## Licença

Distribuído sob a licença MIT. Veja o arquivo [LICENSE](./LICENSE).
