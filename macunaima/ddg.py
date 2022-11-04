import json
import requests

url = 'https://api.duckduckgo.com/?format=json&q='

def search(term)-> str | dict:
    response = requests.get(url + term)
    json_response = response.json()
    
    if response.status_code != 200:
        return 'Erro ao consultar'
    elif json_response['Results']:
        # return json_response['Results'][0]['FirstURL'])
        # print(json_response['Results'][0]['Text'])
        return json_response['Results'][0]
    elif json_response['AbstractURL']:
        # abstract = json_response['AbstractURL']
        return json_response['AbstractURL']
    else:
        return 'Nada encontrado'