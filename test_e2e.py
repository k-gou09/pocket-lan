"""Test end-to-end : session, conversation, chat via WebSocket."""
import asyncio
import json
import httpx
import websockets

BASE = "http://localhost:8000"
WS_URL = "ws://localhost:8000/ws?sid=test_e2e_session"


async def test():
    async with httpx.AsyncClient() as http:
        # 1. Health check
        r = await http.get(BASE + "/api/health")
        data = r.json()
        print("=== HEALTH ===")
        print(json.dumps(data, indent=2))

        # 2. Get session
        r = await http.get(BASE + "/api/session")
        sess = r.json()["session"]
        sid = sess["id"]
        print("\n=== SESSION ===")
        print("sid:", sid)

        # 3. Create conversation
        r = await http.post(
            BASE + "/api/conversations",
            json={"title": "Test E2E"},
            cookies={"pocket_sid": sid},
        )
        conv = r.json()["conversation"]
        print("\n=== CONVERSATION ===")
        print("conv_id:", conv["id"], "title:", conv["title"])

    # 4. WebSocket chat
    print("\n=== WEBSOCKET CHAT ===")
    async with websockets.connect(WS_URL) as ws:
        # Receive snapshot first
        snap = await ws.recv()
        snap_data = json.loads(snap)
        print("Snapshot type:", snap_data.get("type"))

        # Send hello
        await ws.send(json.dumps({"type": "hello", "name": "TestBot"}))
        resp = await ws.recv()
        resp_data = json.loads(resp)
        print("Hello response type:", resp_data.get("type"))

        # Set model to qwen3.5-4b via global settings
        await ws.send(json.dumps({
            "type": "global",
            "patch": {"model": "qwen3.5-4b"},
        }))
        resp = await ws.recv()
        print("Global settings response:", json.loads(resp).get("type"))

        # Send chat message
        await ws.send(json.dumps({
            "type": "chat",
            "conv_id": conv["id"],
            "text": "Bonjour, comment tu t'appelles ?",
        }))

        # Collect chunks and done
        content_parts = []
        reasoning_parts = []
        final = None
        while True:
            msg = await ws.recv()
            data = json.loads(msg)
            kind = data.get("type")
            if kind == "chunk":
                delta = data.get("delta", "")
                if data.get("kind") == "content":
                    content_parts.append(delta)
                    print(f"  [content chunk] {delta[:50]}...", end="", flush=True)
                elif data.get("kind") == "reasoning":
                    reasoning_parts.append(delta)
            elif kind == "done":
                final = data
                break
            elif kind == "error":
                print(f"  ERROR: {data.get('message')}")
                break

        full_content = "".join(content_parts).strip()
        full_reasoning = "".join(reasoning_parts).strip()

        print("\n=== RESULT ===")
        print("Content length:", len(full_content))
        if full_content:
            print("Content preview:", full_content[:200])
        else:
            print("Content: (empty)")
        if full_reasoning:
            print("Reasoning length:", len(full_reasoning))
            print("Reasoning preview:", full_reasoning[:200])

        if final:
            print("\nDone payload:")
            print(f"  used_reasoning: {final.get('used_reasoning')}")
            print(f"  elapsed_ms: {final.get('elapsed_ms')}")
            print(f"  tokens total: {final.get('usage', {}).get('total_tokens')}")


if __name__ == "__main__":
    asyncio.run(test())
