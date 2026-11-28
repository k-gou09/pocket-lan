"""Chargement des modeles dans LM Studio via le CLI lms.

Le CLI n'est pas obligatoire : si un modele est deja charge dans LM Studio,
l'application l'utilise directement. Le CLI sert uniquement quand on veut
changer de modele. La fenetre de contexte est celle du modele dans LM Studio.

Options utilisees (constatees avec 'lms load --help') :
  -y                    repond oui aux invites, necessaire en script
  --parallel            nombre de predictions simultanees
  --identifier          identifiant utilise par l'API
"""

import asyncio
import re
import shutil

from . import config

SIZE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB)", re.IGNORECASE)
FACTOR = {"KB": 1 / 1024 / 1024, "MB": 1 / 1024, "GB": 1.0, "TB": 1024.0}


def cli_path():
    return config.LMS_CLI or shutil.which("lms") or ""


def cli_available():
    return bool(cli_path())


def model_size_gb(model_id):
    """Taille du modele sur disque, en Go, ou None si le CLI est absent."""
    path = cli_path()
    if not path or not model_id:
        return None

    try:
        output = subprocess_run([path, "ls"], timeout=30)
    except Exception:  # noqa: BLE001 - le CLI peut etre occupe, ce n'est pas bloquant
        return None

    for line in output.splitlines():
        if model_id.lower() in line.lower():
            match = SIZE_PATTERN.search(line)
            if match:
                return float(match.group(1)) * FACTOR[match.group(2).upper()]
    return None


def subprocess_run(args, timeout=60):
    import subprocess

    completed = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    return (completed.stdout or "") + (completed.stderr or "")


async def load_model(model_id, parallel=None, force=False):
    """Charge un modele dans LM Studio et rend le resultat de la commande."""
    path = cli_path()
    if not path:
        raise RuntimeError(
            "Le CLI lms est absent : charge le modele dans LM Studio, "
            "ou renseigne la variable d'environnement LMS_CLI."
        )

    size = model_size_gb(model_id)
    limit = config.MAX_MODEL_SIZE_GB
    if size is not None and limit > 0 and size > limit and not force:
        raise RuntimeError(
            "Modele trop gros pour un usage partage : "
            + f"{size:.2f} Go"
            + " (seuil "
            + f"{limit:.1f} Go"
            + "). Force-le avec force=true si la machine est assez puissante."
        )

    args = [path, "load", model_id, "-y"]
    if parallel:
        args += ["--parallel", str(int(parallel))]

    output = await asyncio.to_thread(subprocess_run, args, 180)
    if "error" in output.lower() and "no model" in output.lower():
        raise RuntimeError(output.strip()[:400])
    return {"ok": True, "output": output.strip()[:400], "size_gb": size}


