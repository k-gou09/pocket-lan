# Pocket LAN v0.2.1

## ⚠️ Important si vous venez de la version 0.2.0

Le bouton « Mettre à jour » de la version 0.2.0 ne sait installer une mise à jour
que depuis un clone Git. Si vous avez installé Pocket LAN en téléchargeant un ZIP
de la version 0.2.0, **téléchargez et installez une fois cette version v0.2.1**.

Après cette réinstallation unique, les mises à jour suivantes se feront en un
seul clic, que l'application ait été installée depuis un ZIP ou un clone Git.

## Nouveautés

- Support de **LM Studio et Ollama** avec un seul client compatible OpenAI.
- Réglages simplifiés : seul le budget d'historique reste visible ; la longueur,
  la température et la fenêtre de contexte sont gérées par le backend.
- Trois avatars : Pocket inchangé, Nova « la curieuse » et Iris « la lucide »,
  chacun avec son prompt système et ses visèmes.
- Pièces jointes : fichiers, images et photo de la caméra. Les images sont envoyées
  directement au modèle vision, les PDF et fichiers texte sont extraits côté serveur.
- Le raisonnement ne fuit plus dans les réponses (`reasoning_effort: "none"`).
- Mises à jour simplifiées : plus de jeton administrateur, un seul bouton
  « Mettre à jour », installation depuis Git ou depuis une archive ZIP,
  réinstallation de `requirements.txt` et redémarrage automatique.
- Correctifs divers et 19 tests unitaires.
