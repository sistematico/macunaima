# 🤖 Macunaíma

<div align="center">
    <img src="./assets/macunaima2.jpg" alt="Macunaíma" />
</div>

Um “bot” de utilidades para o [Telegram](https://telegram.org).

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
