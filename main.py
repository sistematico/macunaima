#!/usr/bin/env python

import os
import logging
from telegram import ReplyKeyboardRemove, Update
from telegram.ext import Updater, CommandHandler, MessageHandler, ConversationHandler, CallbackContext, Filters
from macunaima.ddg import search

# Enable logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

URL = os.environ.get('URL', 'https://macunaima.fly.dev/')
TOKEN = os.environ.get('TOKEN')
MODE = os.environ.get('MODE', 'production')

WEATHER, LOCATION = range(2)

def start(update: Update, context: CallbackContext) -> None:
    update.message.reply_text('Ai que preguiça...')

def weather(update: Update, context: CallbackContext) -> int:
    update.message.reply_text(f'OK, vou te enviar as condições climáticas!\n\nMas antes, preciso que me envie sua localização, se quiser cancelar, digite /cancelar')
    return LOCATION

def location(update: Update, context: CallbackContext) -> None:
    if update.message.location:
        current_pos = (update.message.location.latitude, update.message.location.longitude)
        print(current_pos)
        update.message.reply_text(str(current_pos))

def ddg(update: Update, context: CallbackContext) -> None:
    if update.message.text.partition(' ')[2]:
        resultado = search(update.message.text.partition(' ')[2])
        text = resultado['text']
        url = resultado['url'] if resultado['url'] != None else 'URL não acontrada'
        update.message.reply_text(f'{text}\n\nSite: {url}', disable_web_page_preview=True)

def cancel(update: Update, context: CallbackContext) -> int:
    update.message.reply_text('Você tambem tá com preguiça né? Entendo..', reply_markup=ReplyKeyboardRemove())
    return ConversationHandler.END

def main() -> None:
    updater = Updater(TOKEN)
    dispatcher = updater.dispatcher
    dispatcher.add_handler(CommandHandler("start", start))
    dispatcher.add_handler(CommandHandler("ddg", ddg))
    dispatcher.add_handler(
        ConversationHandler(
            entry_points=[CommandHandler('w', weather)],
            states={
                LOCATION: [
                    MessageHandler(Filters.location, location),
                    CommandHandler('pular', cancel),
                ]
            },
            fallbacks=[CommandHandler('cancelar', cancel)],
        )
    )

    if MODE.startswith('dev'):
        updater.start_polling() # Polling
    else:
        updater.start_webhook(listen="0.0.0.0", port=8080, url_path=TOKEN, webhook_url=URL + TOKEN) # Webhook
    
    updater.idle()

if __name__ == '__main__':
    main()
