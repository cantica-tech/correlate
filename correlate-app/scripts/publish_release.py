"""Publish a correlate-app release to the cantica-tech distribution repository
(br-BUILD-000008, br-BUILD-000010; REQ-000054-sJpO9KMY).

The release workflow (`.github/workflows/release.yml`) builds a version's
installers into a draft GitHub Release of this repository. This script
copies them to the distribution repository's checkout (`--publish-dir`,
`cantica-tech/cantica-tech`), as its other products are distributed there:

- `correlate/v<version>/manifest.json`: the version, the Sump image, and each
  file's system, architecture, size, SHA-256 and download link: the
  installers, and the Sump image saved per architecture (for `docker load`);
- `correlate/v<version>/*.zip.001`, `.002`, ...: each of those files zipped,
  the zip cut into numbered pieces under GitHub's 100 MB (one `*.zip` when
  it fits); 7-Zip opens `.001` directly, `cat` joins them elsewhere;
- `correlate/v<version>/README.md`: how to install it, and open the zips;
- `correlate/README.md`: the index of every version, made again from the
  manifests; and a line for `correlate/` in the repository's README.

GitHub refuses files over 100 MB in git, and every installer is larger, so
the files whole are the assets of a release `correlate-v<version>` of the
distribution repository, which the manifests link to; in git they are the
zips' pieces. The image files come from the release workflow; for a version
built before it saved them, `--image-dir` gives them (`docker save`). The
pieces are an ordinary zip cut in order, not a `zip -s` split archive:
macOS's `zip` 3.0 joins those wrongly.

Without `--push` the files are written and nothing is committed, pushed or
released. With it they are committed ("Deploy release: correlate-app
v<version>") and pushed, then the release is made with the installers.

Usage: python scripts/publish_release.py [--version X.Y.Z]
       [--publish-dir ../../cantica-tech] [--image-dir DIR] [--push] [--replace]
Standard library only; GitHub through the `gh` CLI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import cast

#: This repository, where the release workflow makes the draft release.
SOURCE_REPO = "cantica-tech/correlate"
#: The distribution repository.
TARGET_REPO = "cantica-tech/cantica-tech"
#: The Sump image each version provisions.
IMAGE = "ghcr.io/cantica-tech/correlate-sump"
#: correlate-app's folder in the distribution repository.
FOLDER = "correlate"
#: An installer's name, as electron-builder writes it (`artifactName`).
INSTALLER = re.compile(
    r"^correlate-app-(?P<version>[0-9.]+)-(?P<os>mac|win|linux)-(?P<arch>[A-Za-z0-9_]+)\.(?P<ext>dmg|exe|AppImage)$"
)
#: The Sump image saved for one architecture, as the release workflow names it.
IMAGE_FILE = re.compile(r"^correlate-sump-(?P<version>[0-9.]+)-linux-(?P<arch>amd64|arm64)\.tar$")
SYSTEMS = {"mac": "macOS", "win": "Windows", "linux": "Linux"}
#: A zip's largest piece in git: under GitHub's 100 MB, with room.
PART = 95 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent


class PublishError(Exception):
    """Why a publication stopped, before anything was pushed."""


def run(args: list[str], cwd: Path | None = None) -> str:
    """Run a command; its output, or `PublishError` with what it said."""
    done = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise PublishError(f"{' '.join(args[:3])}: {(done.stderr or done.stdout).strip()[:500]}")
    return done.stdout


def app_version() -> str:
    """The version in `app/package.json` (the app's and the Sump's, br-BUILD-000007)."""
    return str(json.loads((ROOT / "app" / "package.json").read_text(encoding="utf-8"))["version"])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_release_file(name: str) -> bool:
    """An installer, or the Sump image saved for one architecture."""
    return bool(INSTALLER.match(name) or IMAGE_FILE.match(name))


def describe(path: Path, version: str) -> dict[str, object]:
    """One file's entry in the manifest: an installer, or the Sump image."""
    found = INSTALLER.match(path.name)
    image = IMAGE_FILE.match(path.name)
    if found is not None and found["version"] == version:
        kind, system, arch = "installer", SYSTEMS[found["os"]], found["arch"]
    elif image is not None and image["version"] == version:
        kind, system, arch = "sump-image", "Linux (Docker)", image["arch"]
    else:
        raise PublishError(f"{path.name} is not a correlate-app {version} release file")
    return {
        "file": path.name,
        "kind": kind,
        "system": system,
        "arch": arch,
        "size": path.stat().st_size,
        "sha256": sha256(path),
        "url": f"https://github.com/{TARGET_REPO}/releases/download/{FOLDER}-v{version}/{path.name}",
    }


def split_zip(source: Path, into: Path) -> list[dict[str, object]]:
    """`source` zipped into `into`, the zip cut into pieces of at most `PART`
    bytes (`<name>.zip.001`, `.002`, ...; `<name>.zip` alone when it fits);
    the pieces, in the order to join them."""
    name = source.name + ".zip"
    for old in [*into.glob(name + ".[0-9][0-9][0-9]"), into / name]:
        old.unlink(missing_ok=True)
    whole = into / (name + ".tmp")
    with zipfile.ZipFile(whole, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.write(source, source.name)
    if whole.stat().st_size <= PART:
        whole.rename(into / name)
        pieces = [into / name]
    else:
        pieces = []
        with whole.open("rb") as f:
            for n, block in enumerate(iter(lambda: f.read(PART), b""), start=1):
                piece = into / f"{name}.{n:03d}"
                piece.write_bytes(block)
                pieces.append(piece)
        whole.unlink()
    return [{"file": p.name, "size": p.stat().st_size, "sha256": sha256(p)} for p in pieces]


def manifest(
    version: str,
    files: list[dict[str, object]],
    archives: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "id": "correlate-app",
        "name": "correlate-app",
        "version": version,
        "description": (
            "Correlates container telemetry with service logs on one shared, clickable"
            " timeline; its Sump collects them."
        ),
        "sumpImage": f"{IMAGE}:{version}",
        "release": f"{FOLDER}-v{version}",
        "files": sorted(files, key=lambda f: (str(f["kind"]), str(f["system"]), str(f["arch"]))),
        # Each file zipped in this folder: its parts, in the order to join them.
        "archives": archives or [],
    }


def _row(f: dict[str, object]) -> str:
    """One installer's line in a version's README."""
    size = int(str(f["size"])) // 1048576
    return f"| {f['system']} | `{f['arch']}` | [`{f['file']}`]({f['url']}) | {size} MB |"


def _zip_row(a: dict[str, object]) -> str:
    """One zipped file's line: its parts, linked in this folder."""
    parts = cast("list[dict[str, object]]", a["parts"])
    links = ", ".join(f"[`{p['file']}`]({p['file']})" for p in parts)
    return f"| `{a['of']}` | {links} |"


def version_readme(m: dict[str, object]) -> str:
    """How to install one version."""
    version = m["version"]
    files = cast("list[dict[str, object]]", m["files"])
    rows = "\n".join(_row(f) for f in files if f["kind"] == "installer")
    images = "\n".join(_row(f) for f in files if f["kind"] == "sump-image")
    archives = cast("list[dict[str, object]]", m.get("archives", []))
    zips = "\n".join(_zip_row(a) for a in archives)
    image_part = (
        f"""
The Sump image, saved per architecture, to load where the registry cannot be
reached (`docker load -i <file>`; then the app provisions it as usual):

| System | Architecture | Image | Size |
| ------ | ------------ | ----- | ---- |
{images}
"""
        if images
        else ""
    )
    zip_part = (
        f"""
## The zips in this folder

Each file above, zipped; a zip over 95 MB is cut into numbered pieces
(`.001`, `.002`, ...). Download every piece of one file into one folder,
then open its `.001` with 7-Zip, which joins them; or join them and unzip:
`cat <name>.zip.0* > <name>.zip && unzip <name>.zip` (macOS, Linux), or
`copy /b <name>.zip.001+<name>.zip.002 <name>.zip` (Windows, every piece in
order).

| File | Pieces |
| ---- | ----- |
{zips}
"""
        if zips
        else ""
    )
    return f"""# correlate-app {version}

Installers for correlate-app {version}. The Sump it provisions is
`{m["sumpImage"]}`, for amd64 and arm64. Each file's SHA-256 is in
[`manifest.json`](manifest.json).

| System | Architecture | Installer | Size |
| ------ | ------------ | --------- | ---- |
{rows}
{image_part}
The installers may be unsigned; the system then asks before opening them.
On macOS, right-click the app and choose Open (or allow it in System
Settings, Privacy & Security). On Windows, choose More info, then Run anyway.
On Linux, make the AppImage executable (`chmod +x`) and run it.
{zip_part}"""


def index_readme(folder: Path) -> str:
    """The index of every version, newest first, from their manifests."""
    found = []
    for path in folder.glob("v*/manifest.json"):
        m = json.loads(path.read_text(encoding="utf-8"))
        found.append(m)
    found.sort(key=lambda m: [int(p) for p in str(m["version"]).split(".")], reverse=True)
    rows = "\n".join(
        f"| `v{m['version']}` | [`v{m['version']}/README.md`](v{m['version']}/README.md)"
        f" | [`v{m['version']}/manifest.json`](v{m['version']}/manifest.json)"
        f" | `{m['sumpImage']}` |"
        for m in found
    )
    return f"""# correlate-app Releases

Installers of correlate-app, one folder per version. Each folder's
`manifest.json` lists its installers with their size, SHA-256 and download
link; the installers themselves are the assets of the release
`{FOLDER}-v<version>` of this repository (GitHub keeps no file over 100 MB
in git).

| Version | Install | Manifest | Sump image |
| ------- | ------- | -------- | ---------- |
{rows}
"""


ROOT_LINE = (
    f"- **[{FOLDER}/]({FOLDER}/README.md)**: correlate-app releases: installers for"
    " Windows, macOS and Linux, one folder per version."
)


def with_root_line(text: str) -> str:
    """The distribution repository's README with a line for `correlate/`, once."""
    if f"[{FOLDER}/]" in text:
        return text
    lines = text.rstrip("\n").split("\n")
    last = max(
        (i for i, line in enumerate(lines) if line.startswith("- **[")), default=len(lines) - 1
    )
    return "\n".join([*lines[: last + 1], ROOT_LINE, *lines[last + 1 :]]) + "\n"


def check_checkout(publish_dir: Path) -> None:
    """The distribution repository's clean checkout, on main, up to date."""
    if not (publish_dir / ".git").exists():
        raise PublishError(f"{publish_dir} is not a checkout of {TARGET_REPO}")
    remote = run(["git", "remote", "get-url", "origin"], publish_dir).strip()
    if TARGET_REPO not in remote:
        raise PublishError(f"{publish_dir} is a checkout of {remote}, not {TARGET_REPO}")
    if run(["git", "status", "--porcelain"], publish_dir).strip():
        raise PublishError(f"{publish_dir} has uncommitted changes; commit or stash them first")
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], publish_dir).strip()
    if branch != "main":
        raise PublishError(f"{publish_dir} is on {branch}, not main")
    run(["git", "pull", "--ff-only", "--quiet"], publish_dir)


def download(version: str, into: Path) -> list[Path]:
    """The installers and image files of the release `v<version>` of this
    repository (a draft too)."""
    run(["gh", "release", "view", f"v{version}", "-R", SOURCE_REPO, "--json", "assets"])
    run(
        [
            "gh",
            "release",
            "download",
            f"v{version}",
            "-R",
            SOURCE_REPO,
            "-D",
            str(into),
            "--clobber",
        ]
    )
    found = sorted(p for p in into.iterdir() if is_release_file(p.name))
    if not any(INSTALLER.match(p.name) for p in found):
        raise PublishError(f"the release v{version} of {SOURCE_REPO} has no installers")
    return found


def publish(
    version: str,
    publish_dir: Path,
    push: bool,
    replace: bool,
    image_dir: Path | None = None,
) -> str:
    """Write, and with `push` commit, push and release; what was done."""
    check_checkout(publish_dir)
    release = f"{FOLDER}-v{version}"
    exists = (
        subprocess.run(
            ["gh", "release", "view", release, "-R", TARGET_REPO], capture_output=True, check=False
        ).returncode
        == 0
    )
    if exists and not replace:
        raise PublishError(
            f"{TARGET_REPO} already has the release {release} (--replace to redo it)"
        )
    with tempfile.TemporaryDirectory() as tmp:
        installers = download(version, Path(tmp))
        if image_dir is not None:
            extra = [p for p in image_dir.iterdir() if IMAGE_FILE.match(p.name)]
            have = {p.name for p in installers}
            installers += sorted(p for p in extra if p.name not in have)
        if not any(IMAGE_FILE.match(p.name) for p in installers):
            raise PublishError(
                f"no Sump image file for {version}: the release has none (built before the"
                " workflow saved them); give them with --image-dir"
            )
        folder = publish_dir / FOLDER
        target = folder / f"v{version}"
        target.mkdir(parents=True, exist_ok=True)
        archives: list[dict[str, object]] = [
            {"of": p.name, "parts": split_zip(p, target)} for p in installers
        ]
        m = manifest(version, [describe(p, version) for p in installers], archives)
        (target / "manifest.json").write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
        (target / "README.md").write_text(version_readme(m), encoding="utf-8")
        (folder / "README.md").write_text(index_readme(folder), encoding="utf-8")
        root = publish_dir / "README.md"
        root.write_text(with_root_line(root.read_text(encoding="utf-8")), encoding="utf-8")
        if not push:
            return f"wrote {target.relative_to(publish_dir)}; nothing committed, pushed or released"
        run(["git", "add", FOLDER, "README.md"], publish_dir)
        if run(["git", "status", "--porcelain"], publish_dir).strip():
            run(
                ["git", "commit", "-q", "-m", f"Deploy release: correlate-app v{version}"],
                publish_dir,
            )
            run(["git", "push", "-q", "origin", "main"], publish_dir)
        notes = Path(tmp) / "notes.md"
        notes.write_text(version_readme(m), encoding="utf-8")
        if exists:
            run(
                [
                    "gh",
                    "release",
                    "upload",
                    release,
                    "-R",
                    TARGET_REPO,
                    "--clobber",
                    *map(str, installers),
                ]
            )
        else:
            run(
                [
                    "gh",
                    "release",
                    "create",
                    release,
                    "-R",
                    TARGET_REPO,
                    "--target",
                    "main",
                    "--title",
                    f"correlate-app {version}",
                    "--notes-file",
                    str(notes),
                    *map(str, installers),
                ]
            )
    return f"published correlate-app {version}: {FOLDER}/v{version} and the release {release}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", default=None, help="the version (default: app/package.json's)")
    parser.add_argument(
        "--publish-dir",
        default=str(ROOT.parent.parent / "cantica-tech"),
        help="the distribution repository's checkout (default: ../cantica-tech beside this one)",
    )
    parser.add_argument("--push", action="store_true", help="commit, push and make the release")
    parser.add_argument("--replace", action="store_true", help="redo a version already released")
    parser.add_argument(
        "--image-dir",
        default=None,
        help="a folder holding correlate-sump-<version>-linux-<arch>.tar files (docker save)",
    )
    args = parser.parse_args(argv)
    try:
        print(
            publish(
                args.version or app_version(),
                Path(args.publish_dir).resolve(),
                args.push,
                args.replace,
                Path(args.image_dir).resolve() if args.image_dir else None,
            )
        )
    except PublishError as exc:
        print(f"publish: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
