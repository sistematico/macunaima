# 🤖 Macunaíma

<!--suppress HtmlDeprecatedAttribute -->
<div align="center">
    <img src="./assets/macunaima2.jpg" alt="Macunaíma" />
</div>

Um “bot” de utilidades para o [Telegram](https://telegram.org).

> Ai que preguiça...

### 🏃‍♂️ CI/CD

[![Fly.io Deploy](https://github.com/sistematico/macunaima/actions/workflows/fly.yml/badge.svg)](https://github.com/sistematico/macunaima/actions/workflows/fly.yml)

### 📦 Instalação e testes

- Para testes locais utilize o modo `polling`, para produção o modo `webhook` setados através da variável de ambiente `MODE`
- Converse com o [@BotFather](https://t.me/botfather) no Telegram, crie um “bot” e copie o Token para a variável de ambiente `TOKEN`
- Rode o “bot” com o comando `MODE=dev TOKEN='seu_token_do_botfather' python main.py` ou usando o Docker/Podman

### 🌍 Deploy no [Fly.io](https://fly.io)

- Instale o flyctl seguindo as instruções da [documentação](https://fly.io/docs)
- Digite `flyctl launch`
- Digite `flyctl secrets set TOKEN='seu_token_do_botfather'`
- Depois `flyctl deploy`
- Acesse o [painel](https://fly.io/dashboard)

### 👏 Créditos

- [Python Telegram Bot](https://python-telegram-bot.org)
- [PyCharm](https://www.jetbrains.com/pycharm/)
- [Arch Linux](https://archlinux.org)
- [Fé](https://pt.wikipedia.org/wiki/Fé)

### 👏 Ajude

Se o meu trabalho foi útil de qualquer maneira, considere doar qualquer valor através do das seguintes plataformas:

[![LiberaPay](https://img.shields.io/badge/LiberaPay-gray?logo=liberapay&logoColor=white&style=flat-square)](https://liberapay.com/sistematico/donate) [![PagSeguro](https://img.shields.io/badge/PagSeguro-gray?logo=pagseguro&logoColor=white&style=flat-square)](https://pag.ae/bfxkQW) [![ko-fi](https://img.shields.io/badge/ko--fi-gray?logo=ko-fi&logoColor=white&style=flat-square)](https://ko-fi.com/K3K32RES9) [![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-gray?logo=buy-me-a-coffee&logoColor=white&style=flat-square)](https://www.buymeacoffee.com/sistematico) [![Open Collective](https://img.shields.io/badge/Open_Collective-gray?logo=opencollective&logoColor=white&style=flat-square)](https://opencollective.com/sistematico) [![Patreon](https://img.shields.io/badge/Patreon-gray?logo=patreon&logoColor=white&style=flat-square)](https://patreon.com/sistematico)


[![GitHub Sponsors](https://img.shields.io/github/sponsors/sistematico?label=Github%20Sponsors)](https://github.com/sponsors/sistematico)
