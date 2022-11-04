#!/usr/bin/env python

import os
import logging
from telegram import Update
from telegram.ext import Updater, CommandHandler, CallbackContext
from macunaima.decorators import rate_limited
from macunaima.ddg import search

# Enable logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

TOKEN = os.environ.get('TOKEN')
MODE = os.environ.get('MODE', 'production')

def start(update: Update, context: CallbackContext) -> None:
    update.message.reply_text('Olá!')

def ddg(update: Update, context: CallbackContext) -> None:
    termo = update.message.text.partition(' ')[2] 
    
    if termo:
        resultado = search(termo)
        update.message.reply_text(resultado)
        # context.bot.send_message('Olá!')

def main() -> None:
    updater = Updater(TOKEN)
    dispatcher = updater.dispatcher
    dispatcher.add_handler(CommandHandler("start", start))
    dispatcher.add_handler(CommandHandler("ddg", ddg))

    if MODE.startswith('dev'):
        updater.start_polling() # Polling
    else:
        updater.start_webhook(listen="0.0.0.0", port=8080, url_path=TOKEN, webhook_url="https://macunaima.fly.dev/" + TOKEN) # Webhook
    
    updater.idle()

if __name__ == '__main__':
    main()
