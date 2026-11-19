# Pocket LAN

Version Python de **LLM Pocket** : serveur FastAPI + interface PC en deux volets
(robot anime a gauche, chat a droite), propulse par **LM Studio** en local.

Un controle dans la barre superieure bascule entre trois modes d'affichage :
chat seul, les deux volets cote a cote, ou avatar seul (experience voix). Le
choix est memorise par navigateur.

Le projet d'origine (PWA sur GitHub Pages, inference WebAssembly sur la tablette)
reste intact. Ici le moteur n'est plus dans le navigateur : c'est LM Studio.

## Installation

```bat
install.bat
```

`install.bat` :
1. cree le virtualenv `.venv` s'il manque ;
2. l'active, met pip a jour, installe `requirements.txt` ;
3. verifie les dependances et repond que le serveur local de LM Studio est joignable.

Lancement :

```bat
run.bat
```

`run.bat` active le virtualenv, affiche les URLs locales et reseau, puis lance
`uvicorn` sur `0.0.0.0` (port `8000`, variable `POCKET_PORT`).

## Dependances

```
fastapi
uvicorn[standard]
httpx
python-multipart
```

SQLite est dans la bibliotheque standard, la base est creee au premier lancement
dans `data/pocket.db`.

## Ce qui est partage et ce qui ne l'est pas

| Element | Portee |
| --- | --- |
| Conversations, messages | par utilisateur (session = cookie `pocket_sid`) |
| Modele, consigne systeme, file d'attente | global : le moteur est unique dans LM Studio |
| Fenetre de contexte, budget d'historique | global par defaut, reglable par utilisateur |
| Voix, vocalisation, micro, envoi auto | local a chaque navigateur |

Plusieurs personnes peuvent donc discuter en meme temps : chacune voit ses
conversations, mais tout le monde parle au meme modele.

## Salle temps reel

Le WebSocket `/ws` porte : presence, etat de l'avatar, emotions, typage, reglages,
evenements de chat en streaming. L'avatar n'est pilote que par le bus d'evenements
(`bus.js`), comme dans le projet d'origine.

La file d'attente (`FifoGate`, `maxParallel`) est equitable : premiere demande,
premier servi. Une demande en attente n'est pas rejetee, elle est jouee a son tour.

## Fenetre de contexte

Deux niveaux, a ne pas confondre :

1. **Budget d'historique** (par defaut 3000 tokens) applique par le serveur a chaque
   requete : on garde les messages les plus recents, le dernier est toujours conserve.
   Estimation : 4 caracteres par token, ordre de grandeur observe sur les GGUF Qwen.
2. **Fenetre de contexte au chargement** dans LM Studio : `lms load <modele> -y -c <taille>`.
   LM Studio ne peut pas changer cette taille sans recharger le modele. Le champ
   "Fenetre de contexte LM Studio" des reglages est transmis a `lms load`.

## Voix et dictée

La lecture des reponses utilise la voix du navigateur (`speechSynthesis`) : le
choix de la voix, l'activation de la vocalisation et la synchronisation labiale
de l'avatar sont geres cote client, sans modele vocal supplementaire.

La dictee ne demarre jamais toute seule : elle exige un geste utilisateur et une
connexion (le moteur de reconnaissance du navigateur est un service en ligne). Le
TTS et le micro sont desactivables dans l'interface.

## Piege constate sur qwen3-0.6b

`POST /v1/chat/completions` peut renvoyer `content` vide, `finish_reason: length`,
et le texte dans `reasoning_content`, meme avec `chat_template_kwargs.thinking = false`.
Le client lit donc les deux champs : si `content` est vide, le texte rendu est celui
constate dans `reasoning_content`, avec la mention `used_reasoning`. Rien n'est simule.

## Limites

- L'inference ne fonctionne que si le serveur local de LM Studio est **ON** sur le port `1234`.
- `run.bat` ne peut pas ouvrir le pare-feu Windows sans droits administrateur :
  la premiere connexion depuis un autre PC doit etre autorisee, ou il faut ajouter la regle a la main.
- Le CLI `lms` est optionnel. Sans lui, l'application utilise un modele deja charge dans LM Studio.
- La dictee ne demarre jamais toute seule : elle exige un geste utilisateur et une connexion
  (le moteur de reconnaissance du navigateur est un service en ligne).
- Le TTS est desactivable et arretable dans l'interface.

## Structure

```
app/            config.py, store.py, lm_client.py, model_mgr.py, service.py, ws.py, main.py
static/         index.html, css/app.css, css/avatar.css, js/*.js
data/           pocket.db (creee au premier lancement)
check_env.py    controle d'environnement lance par install.bat
install.bat     virtualenv + dependances + verification LM Studio
run.bat         lancement du serveur
```
