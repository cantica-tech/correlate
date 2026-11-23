"""br-BUILD-000010-sJpO9KMY (REQ-000054-sJpO9KMY): a release's distribution
files (`scripts/publish_release.py`): each installer described with its
system, architecture, size and SHA-256, the version's manifest and README,
the index made from every manifest, and the distribution repository's
README naming `correlate/` once."""

import hashlib
import importlib.util
import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = ROOT / "scripts" / "publish_release.py"
_spec = importlib.util.spec_from_file_location("publish_release", _SCRIPT)
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
# No __pycache__ beside the repository's scripts (it is not tracked).
_writes, sys.dont_write_bytecode = sys.dont_write_bytecode, True
try:
    _spec.loader.exec_module(publish)
finally:
    sys.dont_write_bytecode = _writes

NAMES = [
    "correlate-app-0.1.1-mac-arm64.dmg",
    "correlate-app-0.1.1-mac-x64.dmg",
    "correlate-app-0.1.1-win-x64.exe",
    "correlate-app-0.1.1-linux-x86_64.AppImage",
]


def _installers(tmp_path: Path) -> list[Path]:
    paths = []
    for n, name in enumerate(NAMES):
        path = tmp_path / name
        path.write_bytes(bytes([n]) * (n + 1))
        paths.append(path)
    return paths


def test_describes_each_installer_with_its_digest_and_link(tmp_path: Path) -> None:
    arm = _installers(tmp_path)[0]
    assert publish.describe(arm, "0.1.1") == {
        "file": "correlate-app-0.1.1-mac-arm64.dmg",
        "kind": "installer",
        "system": "macOS",
        "arch": "arm64",
        "size": 1,
        "sha256": hashlib.sha256(b"\x00").hexdigest(),
        "url": "https://github.com/cantica-tech/cantica-tech/releases/download/"
        "correlate-v0.1.1/correlate-app-0.1.1-mac-arm64.dmg",
    }
    image = tmp_path / "correlate-sump-0.1.1-linux-arm64.tar"
    image.write_bytes(b"layers")
    described = publish.describe(image, "0.1.1")
    assert (described["kind"], described["system"], described["arch"]) == (
        "sump-image",
        "Linux (Docker)",
        "arm64",
    )
    with pytest.raises(publish.PublishError, match="not a correlate-app 0.1.2"):
        publish.describe(arm, "0.1.2")
    other = tmp_path / "notes.txt"
    other.write_text("x")
    with pytest.raises(publish.PublishError):
        publish.describe(other, "0.1.1")


def test_writes_the_manifest_readme_and_index(tmp_path: Path) -> None:
    files = [publish.describe(p, "0.1.1") for p in _installers(tmp_path)]
    m = publish.manifest("0.1.1", files)
    assert (m["id"], m["version"], m["release"]) == ("correlate-app", "0.1.1", "correlate-v0.1.1")
    assert m["sumpImage"] == "ghcr.io/cantica-tech/correlate-sump:0.1.1"
    assert [f["system"] for f in m["files"]] == ["Linux", "Windows", "macOS", "macOS"]
    assert m["archives"] == []
    readme = publish.version_readme(m)
    assert "# correlate-app 0.1.1" in readme and "correlate-app-0.1.1-win-x64.exe" in readme
    folder = tmp_path / "correlate"
    for version in ("0.1.1", "0.2.0", "0.1.10"):
        (folder / f"v{version}").mkdir(parents=True)
        (folder / f"v{version}" / "manifest.json").write_text(
            json.dumps(publish.manifest(version, []))
        )
    index = publish.index_readme(folder)
    order = [index.index(f"`v{v}`") for v in ("0.2.0", "0.1.10", "0.1.1")]
    assert order == sorted(order)


def test_names_correlate_once_in_the_distribution_readme() -> None:
    before = (
        "# Releases\n\n## Repository Structure\n\n- **[catalyst/](catalyst/README.md)**: kernel.\n"
    )
    after = publish.with_root_line(before)
    assert after.splitlines()[-1].startswith("- **[correlate/](correlate/README.md)**")
    assert "catalyst/" in after.splitlines()[-2]
    assert publish.with_root_line(after) == after


def test_zips_a_file_into_pieces_that_join_back_to_it(tmp_path: Path, monkeypatch) -> None:
    """Each piece under the limit; joined in order and unzipped, the file byte for byte."""
    monkeypatch.setattr(publish, "PART", 64 * 1024)
    source = tmp_path / "correlate-sump-0.1.1-linux-amd64.tar"
    source.write_bytes(os.urandom(200_000))  # incompressible: several pieces
    folder = tmp_path / "v0.1.1"
    folder.mkdir()
    pieces = publish.split_zip(source, folder)
    names = [str(p["file"]) for p in pieces]
    assert names == [f"correlate-sump-0.1.1-linux-amd64.tar.zip.{n:03d}" for n in range(1, 5)]
    assert all(int(str(p["size"])) <= 64 * 1024 for p in pieces)
    joined = tmp_path / "joined.zip"
    joined.write_bytes(b"".join((folder / n).read_bytes() for n in names))
    with zipfile.ZipFile(joined) as z:
        assert z.read(source.name) == source.read_bytes()
    # Made again, the old pieces go first; a small file stays one zip.
    assert [p["file"] for p in publish.split_zip(source, folder)] == names
    small = tmp_path / "correlate-sump-0.1.1-linux-arm64.tar"
    small.write_bytes(b"0" * 1000)
    assert [p["file"] for p in publish.split_zip(small, folder)] == [small.name + ".zip"]
    m = publish.manifest(
        "0.1.1", [publish.describe(source, "0.1.1")], [{"of": source.name, "parts": pieces}]
    )
    readme = publish.version_readme(m)
    assert "docker load -i" in readme and "cat <name>.zip.0*" in readme and names[0] in readme
