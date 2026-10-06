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
vem do cabeçalho `CF-Connecting-IP`. IPv4 conta por endereço. IPv6 conta pelo
prefixo `/64` na entrada e pelo prefixo `/48` na criação; numa operadora móvel
que entrega um `/64` por aparelho, assinantes do mesmo `/48` dividem a cota de
criação.

- Criação: 5 salas por endereço por minuto, 20 por endereço por hora e 250 por
  hora no serviço.
- Salas ativas: no máximo 500, o que corresponde a 250 por hora com validade de
  duas horas.
- Entrada: 20 tentativas por endereço por minuto, reconexões incluídas. Código
  desconhecido recebe 404 sem abrir a sala.
- O diretório guarda até 2000 registros de cota. Com a tabela cheia, o registro
  que expira primeiro é descartado; entrar em uma sala existente nunca é
  recusado por falta de espaço.
- Respostas 429 e 404 do diretório não gravam no storage. As cotas dessas
  recusas ficam em memória enquanto o objeto estiver ativo.
- Uma sala nova vale dez minutos. Quando recebe o primeiro jogador, o diretório
  estende a validade para duas horas a partir dali. Se essa chamada falhar, a
  sala tenta de novo no próximo `JOIN_ROOM` ou `READY`, no início da partida e
  pelo `alarm`, até dez vezes. O `alarm` do Durable Object avisa os jogadores
  com `ROOM_EXPIRED`, fecha os sockets e apaga o estado.
- Cada sala tem no máximo 6 conexões abertas: os 2 jogadores, com um socket
  cada, e até 4 conexões que ainda não mandaram `JOIN_ROOM`. Não há
  espectadores; um terceiro `JOIN_ROOM` recebe erro e a conexão fecha com 4001.
  O teto de 16 sockets do runtime fica só como proteção.
- Uma conexão sem `JOIN_ROOM` tem dez segundos para entrar e não recebe
  broadcast. Quando já há 4, a mais antiga é fechada (1013), então a conexão
  nova de um jogador sempre encontra vaga. A conexão nova de um jogador fecha a
  anterior dele com 4000.
- `LEAVE` fecha a conexão. Cada conexão aceita até 30 mensagens em dez segundos
  e 4096 caracteres ou bytes por mensagem, com validação de payload e do código
  da sala. Frames binários entram na mesma contagem e fecham a conexão com 1003.
- O cliente reconecta depois de uma queda com espera de 1, 2, 4, 8 s e assim
  por diante, até 60 s, em no máximo dez tentativas. Não reconecta depois de
  4000, 4001 ou `ROOM_EXPIRED`.

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
