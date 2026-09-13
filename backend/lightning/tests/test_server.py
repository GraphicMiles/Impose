import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from lightning import server  # noqa: E402


def test_relative_model_path_is_resolved_from_gateway_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    monkeypatch.setattr(server, "LLM_MODEL", "models/model.gguf")
    assert server._model_path() == (tmp_path / "models/model.gguf").resolve()


def test_spawn_passes_absolute_model_path_without_duplicating_models(tmp_path, monkeypatch):
    model = tmp_path / "models" / "model.gguf"
    model.parent.mkdir()
    model.write_bytes(b"model")
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    monkeypatch.setattr(server, "LLM_MODEL", "models/model.gguf")
    monkeypatch.setattr(server, "LLM_PROC", None)

    health = iter([False, True])
    monkeypatch.setattr(server, "llm_reachable", lambda: next(health, True))
    launched = {}

    class FakeProc:
        def poll(self):
            return None

    def popen(cmd, **kwargs):
        launched["cmd"] = cmd
        launched["cwd"] = kwargs["cwd"]
        return FakeProc()

    monkeypatch.setattr(server.subprocess, "Popen", popen)
    assert server.spawn_llm() is True
    assert launched["cmd"][2] == str(model.resolve())
    assert launched["cwd"] == str(model.parent.resolve())
    assert "models/models" not in launched["cmd"][2]
