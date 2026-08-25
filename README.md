# @fabappai/cli

A definição de um projeto Fabapp, no seu disco.

```bash
npx @fabappai/cli login
npx @fabappai/cli link <project-id>
npx @fabappai/cli pull
# edite os .json
npx @fabappai/cli push
```

## Comandos

| | |
|---|---|
| `login` | autoriza esta máquina pelo fluxo de dispositivo. `--scopes "read"` para só leitura, `--no-open` em headless/CI |
| `logout` | esquece o token **nesta máquina**. Ele continua válido no servidor até ser revogado no Studio |
| `status` | a que conta você está autorizado e a que projeto esta pasta está ligada |
| `link <id>` | liga o diretório atual a um projeto. Confere o acesso **antes** de gravar |
| `pull` | traz `fab.schema.json`, `fab.automations.json`, `fab.settings.json`, `fab.connectors.json` e `apps/<slug>/fab.config.json` |
| `push` | envia de volta o que está no disco |
| `deploy` | sobe o que você editou no workspace e publica. `--no-publish` só salva |
| `dev` | roda o app na sua máquina, com o mesmo template que a plataforma usa. `--app <slug>` escolhe a surface, `--reset` refaz o workspace, `--port` muda a porta |

`FABAPP_API_URL` muda a base da API (padrão `https://api.fabapp.ai`).

## O que ele não faz, de propósito

**Não escreve por cima do que você editou.** O `dev` monta `.fabapp/workspace` uma vez; nas execuções seguintes ele **compara** a assinatura do template e avisa se divergiu, em vez de rebaixar por cima. Refazer é escolha sua (`--reset`), e ele diz que isso apaga suas edições.

**Não apaga.** Nem no `pull`, nem no `deploy`: um arquivo que sumiu do seu workspace é **relatado**, nunca removido do app. Seu workspace pode estar velho em relação ao servidor — a IA pode ter editado o app no Studio nesse meio-tempo — e apagar lá por causa de uma ausência aqui destrói trabalho que ninguém pediu para gerenciar.

**Não empurra o que não é seu.** O `deploy` envia só o que você mudou desde que o workspace foi montado. Os 57 componentes da plataforma, o SDK e a casca ficam onde estão. E se você editar um arquivo que o app não pode reescrever, ele **diz** qual — em vez de salvar com 200 e não mudar nada.

**Não escreve credencial em disco.** O token vai para o chaveiro do sistema; sem chaveiro, para um arquivo `0600` — e nesse caso ele **diz**. Uma ferramenta que cai calada para um lugar pior ensina que é sempre seguro.

**Não tem dependência.** Zero pacotes: ele segura uma credencial e fala com o seu backend, e todo pacote no grafo poderia alcançar os dois.

**`fab.connectors.json` e `fab.integrations.json` são só leitura.** Dizem o que o projeto tem conectado — para um agente saber que existe e quais operações chamar — e nunca a credencial. Conectar e rotacionar é na plataforma.

## Servidor MCP

```bash
fabapp mcp     # JSON-RPC sobre stdio, para o Claude Code e o app de desktop
```

Ele usa a credencial que o `fabapp login` já guardou — não pede nem mostra segredo. No `~/.claude.json` ou no config do seu cliente:

```json
{ "mcpServers": { "fabapp": { "command": "npx", "args": ["-y", "@fabappai/cli", "mcp"] } } }
```

| ferramenta | escopo |
|---|---|
| `fabapp_list_projects` · `fabapp_list_apps` · `fabapp_read_definition` · `fabapp_app_status` | leitura |
| `fabapp_write_definition` · `fabapp_deploy` | escrita |

**O escopo decide a lista.** Um token concedido só-leitura não *vê* as ferramentas de escrita. Anunciar uma que vai responder 403 é pior que não anunciá-la: o modelo tenta, falha, e tenta de novo com outros argumentos — a recusa parece problema do pedido e não da permissão.

`fabapp_read_definition` é a que mais importa: sem o schema, um id de modelo errado responde 404 e um campo inventado responde 422. É a primeira coisa que um agente deve chamar.

## Divergência de template

O template — a casca, o SDK, os componentes, o piso de dependências — é copiado pela plataforma a cada build, então uma cópia local envelhece sozinha. O modo de falha seria o pior possível para um comando chamado `dev`: funciona aqui, sai diferente em produção, e nada avisa.

Por isso o workspace guarda a assinatura do template que veio dentro dele, e todo `fabapp dev` compara com a que a plataforma usou no último build do app. Divergiu, ele diz — com os dois valores, para você decidir.

## Precisa do plano Builder ou superior

Uma conta Free não autoriza o CLI.
