#!/usr/bin/env python3
"""Create a source-only handoff ZIP without reading environment/secret stores."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "generated-artifacts" / "sentinel-developer-handoff.zip"
SKIP_DIRS = {
    ".git", ".agents", ".local", ".cache", ".config", "node_modules",
    "__pycache__", "venv", ".venv", "dist", "build", "coverage", ".turbo",
    ".next", "generated-artifacts", "out-tsc", "tmp", ".vite", "logs",
}
ROOT_FILES = {".gitignore", ".npmrc", ".replit", ".replitignore", ".env.example",
              "README.md", "replit.md", "package.json", "pnpm-lock.yaml",
              "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json"}
TOP_DIRS = {"artifacts", "lib", "scripts", "docs"}
FORBIDDEN_NAMES = {"id.json", "keypair.json", "wallet.json", "credentials.json", ".tsbuildinfo",
                   ".env", ".DS_Store", "Thumbs.db"}
FORBIDDEN_EXT = {".log", ".pyc", ".pyo", ".pem", ".key", ".p12", ".pfx",
                 ".sqlite", ".sqlite3", ".db", ".tsbuildinfo", ".map", ".zip",
                 ".tar", ".gz", ".dump", ".bak"}
TOKEN_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b(?:sk_live_|rk_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}"),
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}"),
]
URL_SECRET = re.compile(
    r"(?i)(https?://|wss?://)[^\s\"'`<>]*"
    r"(?:[?&](?:api[-_]?key|access_token|token|secret|authorization)=)"
    r"[^\s\"'`<>&]+"
)
PLACEHOLDER = re.compile(r"(?i)(example|placeholder|redacted|fixture|test|fake|mock|"
                         r"\$\{|YOUR_|<|\.invalid|[?&](?:api[-_]?key|token)=k$)")

def allowed(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if path.is_symlink() or any(p in SKIP_DIRS for p in rel.parts):
        return False
    if rel.parts[0] not in TOP_DIRS and str(rel) not in ROOT_FILES:
        return False
    if path.name in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_EXT:
        return False
    if path.name.startswith(".env") and path.name != ".env.example":
        return False
    if re.search(r"(?i)(?:keypair|wallet)[-_].*\.json$|(?:secret|credential).*\.json$", path.name):
        return False
    return path.is_file()

def description(name: str) -> str:
    p = Path(name)
    special = {
        "README.md": "Complete handoff, installation, strategy, known issues, dependencies and file inventory.",
        ".env.example": "Placeholder-only environment configuration with safety defaults and per-variable comments.",
        ".replit": "Original Replit workflow/routing configuration, exported with read-only/mainnet-off safety flags.",
        ".gitignore": "Version-control exclusions for dependencies, generated artifacts and private configuration.",
        ".replitignore": "Deployment exclusions including generated archives and private configuration.",
        ".npmrc": "pnpm package-manager configuration.",
        "pnpm-workspace.yaml": "Workspace packages, dependency catalog and security/platform overrides.",
        "pnpm-lock.yaml": "Complete resolved transitive dependency lockfile and integrity hashes.",
        "replit.md": "Project context and historical decisions; current explicit policy supersedes older notes.",
        "sample-logs.txt": "Selected real operational failures/warnings; no raw credential-bearing logs.",
        "ERROR-MESSAGES.md": "Source-literal error/guard message inventory with file/line references.",
        "EXPORT-MANIFEST.json": "Archive inventory, sanitized-copy notes and per-file SHA-256 hashes.",
        "scripts/export-sentinel.py": "Repeatable stdlib-only source ZIP builder and credential-pattern checks.",
    }
    if name in special:
        return special[name]
    if p.name == "package.json":
        return f"Dependency manifest and run/build scripts for {p.parent.as_posix()}."
    if p.name == "artifact.toml":
        return f"Replit artifact service and preview/publish routing for {p.parts[1]}."
    if "tsconfig" in p.name:
        return f"TypeScript compiler/project-reference configuration for {p.parent.as_posix()}."
    if p.name == "vite.config.ts":
        return f"Vite frontend/prototype server, build, aliases and host/port configuration for {p.parts[1]}."
    if p.name.endswith(".test.ts"):
        return f"Offline regression tests for {p.name.removesuffix('.test.ts').replace('-', ' ')}."
    if "/generated/" in name:
        return f"Generated API source: {p.stem.replace('-', ' ')}; regenerate from OpenAPI rather than edit."
    if "/ui/" in name:
        return f"Shared React UI primitive: {p.stem.replace('-', ' ')}."
    if "/src/lib/sentinel/" in name:
        return f"Trading-core module for {p.stem.replace('-', ' ')}."
    if "/src/pages/" in name:
        return f"React dashboard page for {p.stem.replace('-', ' ')}."
    if "/src/components/" in name:
        return f"React component for {p.stem.replace('-', ' ')}."
    if "/src/routes/" in name:
        return f"Express API routes for {p.stem.replace('-', ' ')}."
    if "/src/schema/" in name:
        return f"Drizzle database schema/export for {p.stem.replace('-', ' ')}."
    if p.suffix in {".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"}:
        return f"Bundled source visual asset: {p.stem.replace('-', ' ')}."
    if p.suffix == ".md":
        return f"Developer documentation for {p.stem.replace('-', ' ')}."
    if p.name == "openapi.yaml":
        return "OpenAPI API/setting/position schemas used to generate clients and validators."
    if p.suffix in {".css", ".html"}:
        return f"Frontend style/entry document: {p.stem.replace('-', ' ')}."
    return f"{p.suffix.lstrip('.').upper() or 'Source'} module/configuration for {p.stem.replace('-', ' ')} in {p.parent.as_posix()}."

def inspect_text(name: str, text: str) -> list[str]:
    findings = []
    for pattern in TOKEN_PATTERNS:
        if pattern.search(text):
            findings.append(f"{name}: credential/private-key pattern")
    for match in URL_SECRET.finditer(text):
        # Unit-test/example URL strings are not actual provider credentials.
        if not PLACEHOLDER.search(match.group()):
            line = text[:match.start()].count("\n") + 1
            findings.append(f"{name}:{line}: non-placeholder URL credential")
    # A literal exported Solana keypair or mnemonic assigned in source is unsafe.
    for pattern in [
        r"(?i)(?:secretKey|privateKey|mnemonic|seedPhrase)\s*[:=]\s*['\"]([1-9A-HJ-NP-Za-km-z]{80,90})['\"]",
        r"(?i)(?:mnemonic|seedPhrase)\s*[:=]\s*['\"](?:[a-z]+\s+){11,23}[a-z]+['\"]",
    ]:
        if re.search(pattern, text):
            findings.append(f"{name}: literal wallet secret/seed pattern")
    return findings

def error_catalog(files: dict[str, bytes]) -> str:
    lines = ["# Source error / guard message inventory", "",
             "Literal messages, not a claim that every listed condition occurred. "
             "Interpolations are retained symbolically. Some SDK/provider errors originate externally.", ""]
    pat = re.compile(r"throw\s+new\s+(?:[\w.]+Error|Error)\s*\(\s*([\"'`])((?:\\.|(?!\1).)*?)\1", re.S)
    for name, data in sorted(files.items()):
        if "/tests/" in name or "/src/" not in name or not name.endswith((".ts", ".tsx")):
            continue
        text = data.decode("utf-8")
        for match in pat.finditer(text):
            message = re.sub(r"\s+", " ", match.group(2)).replace("|", "\\|")
            line = text[:match.start()].count("\n") + 1
            lines.append(f"- `{name}:{line}` — {message}")
    return "\n".join(lines) + "\n"

def sample_logs() -> str:
    lines = ["SANITIZED OPERATIONAL EXAMPLES", "",
             "Selected real logs observed during this handoff, not synthetic trade fills. "
             "Only timestamp and allowlisted RPC health fields are retained. "
             "No raw URLs, wallet addresses, signatures, provider credentials or request bodies are exported.", ""]
    records = []
    for path in sorted(Path("/tmp/logs").glob("deployment_*.log")):
        for line in path.read_text(errors="replace").splitlines():
            start = line.find('{"event":"sentinel-rpc-balance"')
            if start < 0:
                continue
            try:
                event, _ = json.JSONDecoder().raw_decode(line[start:])
            except ValueError:
                continue
            timestamp = re.search(r"\d{4}-\d\d-\d\dT[\d:.]+Z", line[:start])
            if event.get("outcome") == "failure" or event.get("fallback") is True:
                event = {k: event[k] for k in ("event", "endpointId", "method", "durationMs",
                         "outcome", "fallbackAllowed", "fallback") if k in event}
                records.append((timestamp.group() if timestamp else "[time unavailable]", event))
    for timestamp, event in records[-8:]:
        lines.append(timestamp + " " + json.dumps(event, separators=(",", ":")))
    if not records:
        lines.append("No recoverable deployment RPC failure samples available at export time.")
    lines += ["", "Runtime warnings observed in API startup (verbatim warning text):",
              "bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)",
              "[DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.",
              "", "Verification-mode startup (expected, not an error):",
              "Read-only verification mode: background trading/AI worker is disabled.",
              "", "No raw failed-swap ledger/signature history is included. A wallet-RPC failure "
              "does not establish that a swap was submitted, failed on-chain or filled."]
    return "\n".join(lines) + "\n"

def main() -> None:
    files: dict[str, bytes] = {}
    changes = []
    paths = []
    for directory, children, names in os.walk(ROOT, followlinks=False):
        children[:] = [name for name in children if name not in SKIP_DIRS
                       and not (Path(directory) / name).is_symlink()
                       and (Path(directory) != ROOT or name in TOP_DIRS)]
        paths.extend(Path(directory) / name for name in names)
    for path in sorted(paths):
        if not allowed(path):
            continue
        name = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        if name == ".replit":
            text = data.decode()
            for key, value in (("ENABLE_MAINNET_TRADING", "false"),
                               ("SENTINEL_ALWAYS_ON_CONFIRMED", "false"),
                               ("SENTINEL_READ_ONLY", "true")):
                text = re.sub(rf'(?m)^{key}\s*=\s*"[^"]*"', f'{key} = "{value}"', text)
            data = text.encode()
            changes.append(".replit: exported copy has mainnet/always-on disabled and development read-only enabled")
        files[name] = data
    # Include only uploaded assets actually imported by source, not the user's private uploads.
    imports = set()
    for name, data in list(files.items()):
        if name.endswith((".ts", ".tsx", ".css")):
            imports.update(re.findall(r"""@assets/([^"'`)\s]+)""", data.decode()))
    for name in sorted(imports):
        p = (ROOT / "attached_assets" / name).resolve()
        if ROOT / "attached_assets" not in p.parents or not p.is_file() or p.is_symlink():
            raise SystemExit("Unsafe or missing imported source asset")
        files[p.relative_to(ROOT).as_posix()] = p.read_bytes()
    files["ERROR-MESSAGES.md"] = error_catalog(files).encode()
    files["sample-logs.txt"] = sample_logs().encode()
    dependencies = ["\n## Complete direct dependency inventory\n",
                    "Constraints are exactly as declared. See the lockfile for resolved transitive versions.\n",
                    "| Workspace manifest | Dependency type | Package | Constraint |",
                    "|---|---|---|---|"]
    for name, data in sorted(files.items()):
        if Path(name).name != "package.json":
            continue
        package = json.loads(data)
        for kind in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for dep, version in sorted(package.get(kind, {}).items()):
                dependencies.append(f"| `{name}` | {kind} | `{dep}` | `{version}` |")
    names = sorted(set(files) | {"EXPORT-MANIFEST.json"})
    inventory = ["\n## Every exported file\n", "| File | Purpose |", "|---|---|"]
    inventory += [f"| `{name}` | {description(name)} |" for name in names]
    # A previously exported README already contains the generated appendix.
    base_readme = files["README.md"].decode().split("\n## Complete direct dependency inventory")[0]
    files["README.md"] = (base_readme + "\n" + "\n".join(dependencies + inventory) + "\n").encode()
    findings = []
    for name, data in files.items():
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(inspect_text(name, text))
    if findings:
        # Paths and classifications only; never print matched secrets.
        raise SystemExit("Export blocked; review potential secrets:\n" + "\n".join(findings))
    manifest = {
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "archiveRoot": "sentinel/",
        "scope": "Current workspace source only; not a database/wallet/production-state migration.",
        "sanitizedCopyChanges": changes,
        "excluded": ["real .env files", "wallet/keypair/private credential files", "database dumps/state",
                     "raw logs (sanitized sample-logs.txt exception)", "Git history", "agent/private metadata",
                     "unreferenced uploads", "node_modules/venv/caches", "compiled outputs/source maps"],
        "validation": "Filename exclusions; symlink exclusion; common token/private-key/credential-URL scans; "
                      "no environment values or secret store accessed. Heuristic scan, not a security certification.",
        "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in sorted(files.items())],
        "manifestSelfHash": "Excluded to avoid circularity.",
    }
    files["EXPORT-MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo("sentinel/" + name)
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if name.endswith((".sh", ".py")) else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(OUT) as archive:
        if archive.testzip():
            raise SystemExit("ZIP integrity failure")
    print(json.dumps({"file": OUT.relative_to(ROOT).as_posix(), "files": len(files),
                      "bytes": OUT.stat().st_size, "sha256": hashlib.sha256(OUT.read_bytes()).hexdigest(),
                      "credentialPatternFindings": len(findings)}))

if __name__ == "__main__":
    main()
