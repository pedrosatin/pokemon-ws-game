# Super Trunfo de Stats

Fan demo educacional: Super Trunfo 1v1 no browser/PWA, com WebSocket em Cloudflare Durable Objects e cache de dados estáticos via TanStack Query.

Sem afiliação à Nintendo, Game Freak, Creatures ou The Pokémon Company. Dados via [PokéAPI](https://pokeapi.co/).

## Stack

- React 19 + Vite 8 + TypeScript + Tailwind 4
- PWA (`vite-plugin-pwa`) instalável no celular
- Cloudflare Workers (static assets) + Durable Object hibernável por sala
- TanStack Query (`staleTime: Infinity`) + prefetch no `DEAL`
- Seed gen 1 autoritativo em `shared/gen1-stats.ts`

Roda no **Workers Free**. Detalhes de produto em [`context.md`](./context.md).

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
- Issue de origem: [satinp-portfolio#37](https://github.com/pedrosatin/satinp-portfolio/issues/37)
