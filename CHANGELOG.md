# Changelog

## 0.1.0

A primeira versão. Sete comandos e um servidor MCP.

    fabapp login    autoriza a máquina pelo fluxo de dispositivo (RFC 8628)
    fabapp link     liga um diretório a um projeto
    fabapp pull     traz a definição para o disco
    fabapp push     devolve o que está no disco
    fabapp dev      roda o app localmente, com o template da plataforma
    fabapp deploy   sobe o que você editou e publica
    fabapp status   a que conta e a que projeto
    fabapp logout   esquece o token nesta máquina
    fabapp mcp      servidor MCP sobre stdio

**Zero dependências, e é decisão de segurança.** Ele segura uma credencial e fala com o seu backend; todo pacote no
grafo poderia alcançar os dois. O chaveiro do sistema é alcançado pelo binário que o SO já traz (`security` no
macOS, `secret-tool` no Linux) em vez de um pacote nativo do npm — um cofre de credencial é o último lugar onde se
quer código compilado vindo de um registro.

**Duas coisas que ele não faz**, e são as que têm teste com mutação: `link` confere o acesso ANTES de gravar, e
`pull`/`deploy` RELATAM um arquivo que sumiu em vez de apagá-lo. Um sync que destrói trabalho que ninguém pediu
para gerenciar é pior que sync nenhum.

Requer o plano Builder ou superior.
