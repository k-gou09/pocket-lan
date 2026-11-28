"""Tests unitaires rapides pour backend, pièces jointes et personas.

Lance avec : python -m unittest test_units -v
Aucun serveur ni modele local n'est necessaire.
"""

import asyncio
import io
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock

import httpx

from app import avatar_personas, backends, config, lm_client, personas, service, store, updater, uploads


class _FakeResponse:
    status_code = 200

    def __init__(self, ids):
        self._ids = ids

    def json(self):
        return {"data": [{"id": item} for item in self._ids]}

    def raise_for_status(self):
        return None


class _FakeClient:
    def __init__(self, ids):
        self._ids = ids

    async def get(self, url, timeout=10):
        return _FakeResponse(self._ids)


class _JsonResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _CapabilityClient:
    def __init__(self, payload):
        self._payload = payload

    async def get(self, url, timeout=10):
        return _JsonResponse(self._payload)

    async def post(self, url, json=None, timeout=10):
        return _JsonResponse(self._payload)


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self._original = (config.DATA_DIR, config.DB_PATH, uploads.UPLOAD_DIR, store._CONNECTION)
        self._tmp = tempfile.TemporaryDirectory(prefix="pocket-unit-")
        root = pathlib.Path(self._tmp.name)
        config.DATA_DIR = root
        config.DB_PATH = root / "pocket.db"
        uploads.UPLOAD_DIR = root / "uploads"
        store._CONNECTION = None
        store.connect()

    def tearDown(self):
        if store._CONNECTION is not None:
            store._CONNECTION.close()
        config.DATA_DIR, config.DB_PATH, uploads.UPLOAD_DIR, store._CONNECTION = self._original
        self._tmp.cleanup()

    def _upload(self, name, data, mime):
        meta = uploads.save_upload("session-test", name, data, mime)
        store.save_attachment("session-test", meta)
        return meta

    def test_text_extraction(self):
        meta = self._upload("note.txt", b"Bonjour le monde", "text/plain")
        self.assertEqual(meta["kind"], "text")
        self.assertEqual(meta["text"], "Bonjour le monde")

    def test_pdf_extraction(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("PyMuPDF absent")
        document = pymupdf.open()
        document.new_page().insert_text((50, 50), "Texte PDF de test")
        data = document.tobytes()
        document.close()
        meta = self._upload("doc.pdf", data, "application/pdf")
        self.assertEqual(meta["kind"], "pdf")
        self.assertIn("Texte PDF de test", meta["text"])

    def test_image_data_url(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow absent")
        buffer = io.BytesIO()
        Image.new("RGB", (40, 40), (200, 30, 30)).save(buffer, format="PNG")
        meta = self._upload("photo.png", buffer.getvalue(), "image/png")
        self.assertEqual(meta["kind"], "image")
        self.assertTrue(uploads.image_data_url(meta["path"]).startswith("data:image/jpeg;base64,"))

    def test_history_builds_multimodal_content(self):
        text = self._upload("note.txt", b"Contenu du fichier", "text/plain")
        message = store.add_message("conv", "user", "Question", attachments=[text["id"]])
        store.bind_attachments("session-test", [text["id"]], "conv", message["id"])
        history = store.list_messages("conv")
        built = lm_client.build_messages("SYSTEM", history, 3000)
        self.assertEqual(built[0], {"role": "system", "content": "SYSTEM"})
        parts = built[1]["content"]
        self.assertIsInstance(parts, list)
        self.assertEqual(parts[0]["text"], "Question")
        self.assertIn("Contenu du fichier", parts[1]["text"])

    def test_history_sends_image_to_vision_model(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow absent")
        buffer = io.BytesIO()
        Image.new("RGB", (40, 40), (30, 200, 60)).save(buffer, format="PNG")
        image = self._upload("vue.png", buffer.getvalue(), "image/png")
        message = store.add_message("conv-image", "user", "Qu'y a-t-il ?", attachments=[image["id"]])
        store.bind_attachments("session-test", [image["id"]], "conv-image", message["id"])
        built = lm_client.build_messages("SYSTEM", store.list_messages("conv-image"), 4000)
        parts = built[1]["content"]
        images = [part for part in parts if part.get("type") == "image_url"]
        self.assertEqual(len(images), 1)
        self.assertTrue(images[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    def test_public_message_hides_text(self):
        text = self._upload("secret.txt", b"Contenu prive", "text/plain")
        message = store.add_message("conv", "user", "Question", attachments=[text["id"]])
        public = store.public_message(message)
        self.assertEqual(public["attachments"][0]["name"], "secret.txt")
        self.assertNotIn("text", public["attachments"][0])

    def test_backend_default_and_url(self):
        self.assertEqual(backends.current(), backends.LMS)
        self.assertEqual(backends.base_url("lms"), config.LM_BASE_URL)
        self.assertEqual(backends.base_url("ollama"), config.OLLAMA_BASE_URL)
        self.assertEqual(backends.base_url("ollama", {"ollamaUrl": "http://host:1/"}), "http://host:1")

    def test_resolve_model_falls_back_after_backend_switch(self):
        client = _FakeClient(["gemma3:4b", "qwen3:8b"])
        model, changed = asyncio.run(
            lm_client.resolve_model(client, "google/gemma-4-12b", "http://ollama", "ollama")
        )
        self.assertEqual(model, "gemma3:4b")
        self.assertTrue(changed)

    def test_resolve_model_keeps_valid_model(self):
        client = _FakeClient(["gemma3:4b", "qwen3:8b"])
        model, changed = asyncio.run(
            lm_client.resolve_model(client, "qwen3:8b", "http://ollama", "ollama")
        )
        self.assertEqual(model, "qwen3:8b")
        self.assertFalse(changed)

    def test_resolve_model_empty_ollama_is_explicit(self):
        client = _FakeClient([])
        with self.assertRaises(lm_client.LmError):
            asyncio.run(lm_client.resolve_model(client, "x", "http://ollama", "ollama"))

    def _stream_payload(self, backend):
        captured = {}

        async def handler(request):
            captured.update(json.loads(request.content))
            body = (
                'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(
                200, content=body.encode(), headers={"content-type": "text/event-stream"}
            )

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return [
                    piece
                    async for piece in lm_client.chat_stream(
                        client,
                        "gemma3:4b",
                        [{"role": "user", "content": "salut"}],
                        base_url="http://backend",
                        backend=backend,
                    )
                ]

        return captured, asyncio.run(run())

    def test_ollama_payload_disables_thinking_without_lm_studio_keys(self):
        captured, chunks = self._stream_payload("ollama")
        self.assertEqual(captured["model"], "gemma3:4b")
        # Ollama traduit "none" en think:false : indispensable contre la fuite
        # du raisonnement dans la reponse.
        self.assertEqual(captured["reasoning_effort"], "none")
        self.assertNotIn("chat_template_kwargs", captured)
        # Longueur et temperature viennent des reglages du backend.
        self.assertNotIn("max_tokens", captured)
        self.assertNotIn("temperature", captured)
        self.assertIn(("content", "ok"), chunks)

    def test_lm_studio_payload_disables_thinking(self):
        captured, _ = self._stream_payload("lms")
        self.assertEqual(captured["reasoning_effort"], "none")
        self.assertEqual(captured["chat_template_kwargs"], {"thinking": False})

    def test_reasoning_never_becomes_answer(self):
        leaked = "Thinking Process: 1. Analyze the Request. 2. Reply in French."
        self.assertEqual(service.clean_answer(leaked), "")
        self.assertEqual(service.clean_answer("Raisonnement : 1. Analyser la demande"), "")
        # Le texte reellement produit reste intact.
        self.assertEqual(service.clean_answer("Bonjour, je peux t'aider ?"), "Bonjour, je peux t'aider ?")
        self.assertEqual(service.clean_answer("Analyse rapide terminée."), "Analyse rapide terminée.")

    def test_ollama_vision_capability(self):
        vision = _CapabilityClient({"capabilities": ["completion", "vision"]})
        self.assertTrue(
            asyncio.run(lm_client.supports_vision(vision, "gemma3:4b", "http://ollama", "ollama"))
        )
        text_only = _CapabilityClient({"capabilities": ["completion"]})
        self.assertFalse(
            asyncio.run(lm_client.supports_vision(text_only, "qwen3:8b", "http://ollama", "ollama"))
        )

    def test_lm_studio_vision_capability(self):
        client = _CapabilityClient({"data": [{"id": "qwen-vl", "type": "vlm"}]})
        self.assertTrue(
            asyncio.run(lm_client.supports_vision(client, "qwen-vl", "http://lms", "lms"))
        )

    def test_avatar_personas(self):
        base = personas.resolve_prompt("default")
        self.assertEqual(avatar_personas.system_prompt("default", "pocket"), base)
        for avatar_id, marker in (("nova", "Nova"), ("iris", "Iris")):
            prompt = avatar_personas.system_prompt("default", avatar_id)
            self.assertIn(marker, prompt)
            # L'identite de Pocket ne doit pas contaminer les autres avatars.
            self.assertNotIn("Tu es Pocket", prompt)
            self.assertIn(avatar_personas.HOUSE_RULES, prompt)

    def test_custom_persona_stays_base_for_avatars(self):
        personas._write(
            {"id": "custom", "name": "Custom", "prompt": "Tu es un guide zen.", "description": ""}
        )
        prompt = avatar_personas.system_prompt("custom", "iris")
        self.assertTrue(prompt.startswith("Tu es un guide zen."))
        self.assertIn("Iris", prompt)


class UpdaterTests(unittest.TestCase):
    def test_archive_url_and_safe_tag(self):
        self.assertEqual(updater.safe_tag("v0.2.1"), "v0.2.1")
        self.assertEqual(updater.safe_tag("../evil"), "evil")
        self.assertIn("/archive/refs/tags/v0.2.1.zip", updater.archive_url("v0.2.1"))

    def test_zip_install_preserves_data_and_venv(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app_dir = root / "appdir"
            data_dir = app_dir / "data"
            venv_dir = app_dir / ".venv"
            (app_dir / "static").mkdir(parents=True)
            data_dir.mkdir(parents=True)
            venv_dir.mkdir(parents=True)
            (app_dir / "app.py").write_text("old", encoding="utf-8")
            (app_dir / "requirements.txt").write_text("old-req", encoding="utf-8")
            (data_dir / "keep.txt").write_text("keep", encoding="utf-8")
            (venv_dir / "keep.txt").write_text("venv", encoding="utf-8")

            work = root / "work"
            work.mkdir()
            zip_path = work / "update.zip"
            with zipfile.ZipFile(zip_path, "w") as archive:
                archive.writestr("pocket-lan-9.9/app.py", "new")
                archive.writestr("pocket-lan-9.9/requirements.txt", "new-req")
                archive.writestr("pocket-lan-9.9/static/new.js", "x")
                archive.writestr("pocket-lan-9.9/data/nope.txt", "nope")
                archive.writestr("pocket-lan-9.9/.venv/nope.txt", "nope")

            with mock.patch.object(config, "BASE_DIR", app_dir), mock.patch.object(
                config, "DATA_DIR", data_dir
            ):
                backup = updater.install(work, zip_path, "v9.9")

            self.assertEqual((app_dir / "app.py").read_text(encoding="utf-8"), "new")
            self.assertEqual((app_dir / "requirements.txt").read_text(encoding="utf-8"), "new-req")
            self.assertTrue((app_dir / "static" / "new.js").exists())
            self.assertEqual((data_dir / "keep.txt").read_text(encoding="utf-8"), "keep")
            self.assertFalse((data_dir / "nope.txt").exists())
            self.assertEqual((venv_dir / "keep.txt").read_text(encoding="utf-8"), "venv")
            self.assertFalse((venv_dir / "nope.txt").exists())
            self.assertEqual(
                (pathlib.Path(backup) / "app.py").read_text(encoding="utf-8"), "old"
            )


if __name__ == "__main__":
    unittest.main()
