"""br-BUILD-000007-sJpO9KMY: the app and the Sump carry one version, and a
release tag must equal it (`scripts/check_versions.py`)."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = ROOT / "scripts" / "check_versions.py"
_spec = importlib.util.spec_from_file_location("check_versions", _SCRIPT)
assert _spec is not None and _spec.loader is not None
check_versions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_versions)


def _repo(tmp_path: Path, app: str, server: str) -> Path:
    (tmp_path / "app").mkdir(parents=True)
    (tmp_path / "server").mkdir()
    (tmp_path / "app" / "package.json").write_text(json.dumps({"version": app}))
    (tmp_path / "server" / "pyproject.toml").write_text(f'[project]\nversion = "{server}"\n')
    return tmp_path


def test_this_repository_carries_one_version() -> None:
    assert check_versions.problems(ROOT) == []


def test_differing_versions_and_a_wrong_tag_are_refused(tmp_path: Path, capsys) -> None:
    same = _repo(tmp_path / "same", "1.2.3", "1.2.3")
    assert check_versions.main([str(same)]) == 0
    assert capsys.readouterr().out == "version 1.2.3\n"
    assert check_versions.main(["--tag", "v1.2.3", str(same)]) == 0
    assert check_versions.main(["--tag", "v1.2.4", str(same)]) == 1
    assert "is not v1.2.3" in capsys.readouterr().err
    assert check_versions.main(["--tag", "1.2.3", str(same)]) == 1
    differ = _repo(tmp_path / "differ", "1.2.3", "1.3.0")
    assert check_versions.main([str(differ)]) == 1
    assert "the versions differ" in capsys.readouterr().err
    empty = _repo(tmp_path / "empty", "", "1.0.0")
    assert check_versions.problems(empty) == ["app/package.json has no version"]
