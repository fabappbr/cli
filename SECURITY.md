# Segurança

## Como relatar uma vulnerabilidade

Escreva para **security@fabapp.com**. Não abra issue pública para uma vulnerabilidade — um relato no tracker é
legível por todo mundo, inclusive por quem a usaria, antes de existir correção para instalar.

Confirmamos em **até 2 dias úteis** e damos uma avaliação inicial em **até 7**. Você decide se quer crédito
público. Não há programa de recompensa no momento, e preferimos dizer isso a deixar a pergunta no ar.

## O que este pacote é, em termos de risco

Ele **guarda uma credencial** e **fala com o backend de alguém**. Tudo abaixo decorre dessas duas frases.

- **Zero dependências.** Todo pacote no grafo poderia alcançar as duas coisas.
- **O chaveiro do sistema primeiro**, um arquivo `0600` só como recurso — e o recurso é **dito em voz alta**. Uma
  ferramenta que cai calada para um lugar pior ensina que é sempre seguro.
- **Fluxo de dispositivo (RFC 8628).** Nenhuma chave longa é mostrada a um humano nem digitada num terminal.
- **Escopo separado.** `read` é o padrão; escrever é concessão explícita.
- **Escopado a uma conta**, não à identidade.
- **Publicado por Trusted Publishing (OIDC)** com `--provenance`: não existe token de npm de longa duração em lugar
  nenhum.

## O que ele nunca faz

- **Não escreve fora da pasta do projeto.** Um caminho vindo do servidor que saia da raiz é recusado.
- **Não apaga.** Arquivo que sumiu é relatado, nunca removido do app.
- **Não guarda segredo de integração em disco.** Connector e integração se gerenciam na plataforma.

Verifique uma versão:

```bash
npm audit signatures
npm view @fabappai/cli dist.integrity
```
