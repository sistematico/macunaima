import json
import requests

url = 'https://api.duckduckgo.com/?format=json&q='

result = {
    'text': 'Sem resultados',
    'url': None
}

def search(term: str)-> dict | str:
    response = requests.get(url + term)
    json_response = response.json()
    
    if response.status_code != 200:
        return 'Erro ao consultar'
    elif json_response['Results']:
        result['text'] = json_response['Results'][0]['Text']
        result['url'] = json_response['Results'][0]['FirstURL']
    elif json_response['Abstract']:
        result['text'] = json_response['Abstract']
    else:
        result['text'] = 'Nada encontrado'

    return result