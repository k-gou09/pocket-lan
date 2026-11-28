<p align="center">
  <img src="pre.png" alt="Pocket LAN — assistant IA local" width="900">
</p>

# 🤖 Pocket LAN

**Un assistant IA local fonctionnant avec LM Studio ou Ollama.**

Pocket LAN combine une interface moderne, un avatar animé, la synthèse vocale et des conversations privées exécutées directement sur votre machine.

**Aucune API payante. Aucun abonnement. Vos données restent chez vous.**

🌐 **Page du projet :** https://k-gou09.github.io/pocket-lan/

> ⚠️ **Vous utilisez encore la version 0.2.0 ?**
> Le bouton « Mettre à jour » de cette ancienne version ne sait pas installer une
> mise à jour depuis une archive ZIP. Téléchargez et installez une fois le ZIP de
> **v0.2.1** : ensuite, les mises à jour se font en un seul clic.

Construit pour être simple :

- Installer
- Lancer
- Discuter

## ✨ Fonctionnalités

- 💬 Chat IA local via LM Studio ou Ollama
- 🤖 Avatar animé synchronisé avec la parole
- 🎭 Trois avatars au choix dans les réglages (Pocket, Nova la curieuse et Iris la lucide)
- 📎 Pièces jointes : fichiers, images et photo de la caméra, avec vision directe
- 🔄 Mises à jour en un clic, avec ou sans Git
- 💾 Conversations sauvegardées automatiquement
- 🔊 Synthèse vocale intégrée
- 🖥️ Mode plein écran pour l'avatar
- 📱 Interface responsive (PC, tablette, smartphone)
- ⚡ Streaming des réponses en temps réel
- 🌐 Fonctionne sur le réseau local
- 🗄️ Base SQLite créée automatiquement
- 🖱️ Installation en un clic

## 🚀 Installation

### 1. Installer Python

Téléchargez Python 3.11 ou plus récent :

https://www.python.org/downloads/

⚠️ Durant l'installation, cochez **"Add Python to PATH"**, puis terminez l'installation.

### 2. Installer LM Studio

Téléchargez LM Studio :

https://lmstudio.ai

Installez LM Studio, puis :

- téléchargez un modèle compatible (Qwen, Llama, Mistral, Gemma, Phi…) ;
- chargez le modèle ;
- activez le serveur local.

Port attendu : `http://localhost:1234`

### 3. Installer Pocket LAN

Double-cliquez sur :

```bat
install.bat
```

Le script crée l'environnement Python, installe les dépendances et vérifie que LM Studio est joignable.

### 4. Démarrer l'application

Double-cliquez sur :

```bat
run.bat
```

Puis ouvrez :

http://localhost:8000

💡 **Jeton administrateur** : au premier lancement, Pocket LAN génère automatiquement un jeton et l'affiche dans la console (il est conservé dans `data/admin_token`). Aucune configuration manuelle n'est nécessaire. Il sert uniquement à autoriser les mises à jour depuis l'interface. Pour en générer un nouveau, supprimez `data/admin_token` puis redémarrez.

## 🔄 Mises à jour

Pocket LAN vérifie silencieusement l'existence d'une nouvelle release au démarrage, puis toutes les 6 heures. Quand une version plus récente est disponible, une bannière apparaît dans l'interface.

Cliquez sur « Mettre à jour », saisissez le jeton administrateur affiché dans la console, et le serveur récupère la release, installe les dépendances puis redémarre automatiquement.

Si le dépôt est privé, la détection utilise les tags Git déjà configurés sur votre machine. La variable `POCKET_GITHUB_TOKEN` permet aussi d'autoriser l'API GitHub.

## 🎤 Pourquoi la reconnaissance vocale n'est pas toujours disponible ?

Pocket LAN utilise l'API de reconnaissance vocale fournie par le navigateur.

Les navigateurs modernes imposent plusieurs restrictions :

- une action utilisateur est nécessaire pour démarrer le micro ;
- certains navigateurs désactivent l'API ;
- une connexion Internet est généralement requise ;
- les comportements varient selon Chrome, Edge et Firefox.

Ces limitations proviennent du navigateur lui-même et non de Pocket LAN.

La synthèse vocale (lecture des réponses) continue de fonctionner normalement.

## ⚙️ Architecture

```text
Pocket LAN
    │
    ▼
FastAPI Server
    │
    ▼
LM Studio
    │
    ▼
Modèle IA
```

Toutes les générations sont effectuées localement par LM Studio. Aucune donnée n'est envoyée à un service cloud.

## 🌐 Utilisation sur plusieurs appareils

Une fois lancé, Pocket LAN peut être utilisé depuis :

- PC Windows
- Ordinateurs du réseau local
- Téléphones
- Tablettes

Tous les appareils communiquent avec le même modèle LM Studio, tout en conservant des conversations séparées.

Le premier accès depuis un autre appareil peut nécessiter d'autoriser le port 8000 dans le pare-feu Windows.

## 🎬 Démonstration

Le lancement de l'application, l'avatar animé, l'envoi d'une question, le streaming de la réponse et la synthèse vocale en quelques secondes :

<p align="center">
  <a href="https://youtu.be/j999x2k_apY">
    <img src="https://img.youtube.com/vi/j999x2k_apY/maxresdefault.jpg" alt="Démonstration de Pocket LAN sur YouTube" width="800">
  </a>
</p>

▶️ [Voir la démonstration sur YouTube](https://youtu.be/j999x2k_apY)

## 📄 Licence

Distribué sous licence MIT. Voir le fichier [LICENSE](LICENSE).
